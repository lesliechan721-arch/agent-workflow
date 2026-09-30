import type { Scope } from '../types.js';
import type { CliPrompt } from '../commands/runtime.js';
import {
  executeRemovedPluginOutputCleanup, inspectRemovedPluginCleanup,
  type RebuildCommandRuntime, type RemovedPluginCleanupTarget,
} from '../commands/rebuild-command.js';
import { getDefaultNativeCliRunner } from '../utils/native-cli.js';
import { inventoryCatalogSourceReferences } from '../utils/catalog-source-references.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { resetPluginConfigStore } from '../utils/plugin-config.js';
import { observeIntent, removeRoot } from '../intent/intent-store.js';
import { observePreferences, writePreferences, selectAgents } from '../intent/deployment-preferences.js';
import { assertNeutralAncestorChain, createScopeContext, type ScopeContext } from '../intent/scope-context.js';
import { inspectPortableResidue, type PortableResidue } from '../portable/recovery.js';
import type { RecoveryReceipt, RecoveryTarget } from './receipt.js';

export interface RetireOptions {
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  selector: string;
  targets?: readonly string[];
  deleteConfig?: boolean;
  yes?: boolean;
  interactive?: boolean;
  prompt?: CliPrompt;
  cliVersion?: string;
}
export interface RetirePlan {
  options: RetireOptions;
  context: ScopeContext;
  evidence: RemovedPluginCleanupTarget | null;
  portable: PortableResidue;
  receipt: RecoveryReceipt;
  plannedImpact: { declaration: boolean; preferences: boolean; config: boolean; outputs: boolean };
  intentEvidence: string;
  preferenceEvidence: string;
  changes: string[];
  warnings: string[];
  runtime: RebuildCommandRuntime;
}

function evidence(value: { state: string; rawDigest?: string }): string {
  return `${value.state}:${value.rawDigest ?? ''}`;
}
function diagnostic(code: string, message = `停用受阻：${code}。`) { return { code, message }; }
function safeRemovedEvidence(entry: RemovedPluginCleanupTarget['evidence'][number] | undefined) {
  return entry && { platform: entry.platform, scope: entry.scope,
    plannedActions: entry.plan.actions.map(({ action, kind }) => ({ action, kind })) };
}
function codeOf(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string') return code;
  const removedCode = error instanceof Error ? /\bremovedPlugin[A-Za-z0-9-]+/u.exec(error.message)?.[0] : undefined;
  if (removedCode) return removedCode;
  const first = error instanceof Error ? error.message.split(':')[0] : '';
  return /^[A-Za-z][A-Za-z0-9-]*$/u.test(first) ? first : fallback;
}
function blocksStrongRetirement(code: string, deleteConfig: boolean): boolean {
  return ['pluginIntentStateInvalid', 'deploymentPreferencesInvalid', 'removedPluginActiveUnavailable',
    'removedPluginIntentSourceMismatch',
    'removedPluginOwnershipConflict', 'removedPluginConfigIdentityConflict',
    'removedPluginMarketplaceIdentityConflict'].includes(code)
    || deleteConfig && (code === 'removedPluginConfigTargetUnsupported' || code === 'removedPluginConfigTargetUnsafe');
}
function finish(receipt: RecoveryReceipt, options: RetireOptions, portable: PortableResidue,
  configDeletionCompleted = false): RecoveryReceipt {
  receipt.requestedTargets = receipt.targetResults.map(({ pluginId, agent, scope, delivery }) =>
    ({ pluginId, agent, scope, delivery }));
  receipt.remainingTargets = receipt.targetResults.filter((target) => target.blockers.length
    || !['applied', 'no-op'].includes(target.execution)).map(({ pluginId, agent, scope, delivery }) =>
    ({ pluginId, agent, scope, delivery }));
  receipt.errors = [...receipt.blockers];
  receipt.ok = !receipt.blockers.length && !receipt.remainingTargets.length;
  const agents = [...new Set(receipt.requestedTargets.map((target) => target.agent))];
  const retry = `aw intent retire ${options.selector} --scope ${options.scope}`
    + agents.map((agent) => ` --target ${agent}`).join('')
    + (options.deleteConfig && !configDeletionCompleted ? ' --delete-config' : '');
  receipt.recoveryActions = receipt.ok ? [] : [...new Set([
    ...portable.targets.map((entry) =>
      `请检查并备份 Portable 目录 ${entry.physicalPath}；核验共享读取和归属后自行移开，AW 不自动删除。`),
    retry,
  ])];
  return receipt;
}

export async function prepareRetire(options: RetireOptions, runtime: RebuildCommandRuntime = {}): Promise<RetirePlan> {
  const context = await createScopeContext({ scope: options.scope, cwd: options.cwd, env: options.env });
  try {
    const parsed = parsePluginId(options.selector);
    if (!parsed.sourceId || `${parsed.sourceId}/${parsed.pluginName}` !== options.selector) throw new Error('invalidArguments');
    const [intent, preferences] = await Promise.all([
      observeIntent({ ...options, cwd: context.executionCwd, env: context.env }),
      observePreferences({ ...options, cwd: context.executionCwd, env: context.env }),
    ]);
    const blockers: RecoveryReceipt['blockers'] = [];
    if (intent.state !== 'valid' && intent.state !== 'absent') blockers.push(diagnostic('pluginIntentStateInvalid'));
    if (preferences.state === 'invalid' || preferences.state === 'unreadable') {
      blockers.push(diagnostic('deploymentPreferencesInvalid'));
    }
    const inventory = await (runtime.inventoryCatalogSourceReferences ?? inventoryCatalogSourceReferences)({
      cwd: context.executionCwd, env: context.env, scope: options.scope, includeProjectAgentSkills: true,
    });
    const removed = await inspectRemovedPluginCleanup({ pluginId: options.selector, scope: options.scope,
      inventory, cwd: context.executionCwd, env: context.env,
      nativeCliRunner: runtime.nativeCliRunner ?? getDefaultNativeCliRunner(), codexManager: runtime.codexManager });
    if (!removed) blockers.push(diagnostic('removedPluginActiveUnavailable',
      '需要健康的本地 Active 和插件缺席证据，才能停用已移除插件。'));
    else blockers.push(...removed.blockers.map((message) => diagnostic(codeOf(new Error(message), 'removedPluginBlocked'))));
    if (removed && intent.state === 'valid'
      && intent.value.roots.some((root) => root.pluginId === options.selector)
      && intent.value.sources[parsed.sourceId]?.logicalIdentity !== removed.logicalIdentity) {
      blockers.push(diagnostic('removedPluginIntentSourceMismatch'));
    }
    const requestedAgents = options.targets === undefined ? undefined : selectAgents({ preferences, targets: options.targets }).agents;
    const portable = await inspectPortableResidue({ scope: options.scope, context, selector: options.selector,
      env: context.env, agents: requestedAgents });
    const agents = requestedAgents ?? [...new Set([
      ...(removed?.evidence.filter((entry) => entry.plan.actions.length).map((entry) => entry.platform === 'claude'
        ? 'claude-code' as const : 'codex' as const) ?? []),
      ...(removed && (removed.nativeState === 'installed' || removed.nativeState === 'unknown'
        || removed.projectionPresent || removed.activationScopes.length > 0) ? ['codex' as const] : []),
      ...portable.targets.map((entry) => entry.agent),
      ...(portable.unknownAgents ?? []),
    ])];
    const targetResults: RecoveryTarget[] = agents.map((agent) => {
      const delivery = agent === 'cursor' ? { kind: 'agent-skills' as const, provider: 'skills-cli' as const, agentId: agent }
        : { kind: 'native' as const, platform: agent === 'claude-code' ? 'claude' as const : 'codex' as const };
      const portableUnknown = portable.unknownAgents?.includes(agent) ?? portable.state === 'unknown';
      const hasPortable = portableUnknown || portable.targets.some((target) => target.agent === agent);
      const hasNative = agent !== 'cursor' && (removed?.evidence.some((entry) => entry.platform === delivery.platform)
        || removed?.nativeState === 'installed' || removed?.nativeState === 'unknown'
        || removed?.projectionPresent || (removed?.activationScopes.length ?? 0) > 0);
      return { pluginId: options.selector, agent, scope: options.scope, delivery,
        execution: 'not-run', observation: 'unknown', content: hasPortable || hasNative ? 'unknown' : 'absent',
        blockers: hasPortable ? [diagnostic(portableUnknown
          ? 'portableObservationFailed' : 'backend-action-unsupported')] : [], requiredBy: [options.selector],
        relation: 'residue', backend: { native: safeRemovedEvidence(removed?.evidence.find((entry) =>
          entry.platform === delivery.platform)),
          portable: portable.targets.filter((entry) => entry.agent === agent) } };
    });
    const roots = intent.state === 'valid' ? intent.value.roots.map((root) => root.pluginId)
      : intent.state === 'absent' ? [] : null;
    const selection = preferences.state === 'valid' || preferences.state === 'absent'
      ? selectAgents({ preferences, targets: options.targets })
      : { agents: [], origin: 'none' as const, preferences: preferences.state };
    const receipt: RecoveryReceipt = { schemaVersion: 1, kind: 'aw-recovery', scope: options.scope,
      command: 'intent:retire', ok: false, intent: { state: intent.state,
        ...('digest' in intent ? { digest: intent.digest } : {}), roots }, requestedRoots: [options.selector],
      requestedTargets: [], selection, blockers, errors: [], targetResults, remainingTargets: [], recoveryActions: [],
      declarationChanged: false, preferencesChanged: false, configChanged: false, outputsMayHaveChanged: false };
    const plannedImpact = {
      declaration: roots?.includes(options.selector) === true,
      preferences: preferences.state === 'valid' && preferences.value.dependencyScopeOverrides.some((entry) =>
        entry.pluginId === options.selector),
      config: options.deleteConfig === true && removed?.configTargets.some((entry) =>
        entry.scope === options.scope && entry.kind !== 'absent') === true,
      outputs: removed?.evidence.some((entry) => entry.plan.actions.length > 0
        && agents.includes(entry.platform === 'claude' ? 'claude-code' : 'codex')) === true,
    };
    const changes = [
      ...(plannedImpact.declaration ? [`删除 ${options.scope} 声明 ${options.selector}。`] : []),
      ...(plannedImpact.preferences ? [`删除 ${options.scope} 本地依赖范围覆盖。`] : []),
      ...(plannedImpact.config ? [`删除 ${options.scope} 已保存配置。`] : []),
      ...agents.filter((agent) => agent !== 'cursor').map((agent) =>
        `检查并清理 ${options.scope}/${agent} 已验证原生输出。`),
    ];
    return { options, context, evidence: removed, portable, receipt: finish(receipt, options, portable),
      intentEvidence: evidence(intent), preferenceEvidence: evidence(preferences), plannedImpact, changes,
      warnings: portable.state === 'present' ? ['Portable 输出需人工核验，AW 不自动删除。'] : [], runtime };
  } catch (error) { await context.dispose(); throw error; }
}

export async function executeRetire(plan: RetirePlan, execution: { yes?: boolean; runtime?: RebuildCommandRuntime } = {}): Promise<RecoveryReceipt> {
  const receipt = structuredClone(plan.receipt);
  const runtime = { ...plan.runtime, ...execution.runtime };
  let configDeletionCompleted = false;
  try {
    for (const target of receipt.targetResults) {
      if (target.delivery?.kind === 'agent-skills' && plan.portable.state === 'absent'
        && target.content === 'absent' && target.blockers.length === 0) {
        target.execution = 'no-op';
        target.observation = 'missing';
      }
    }
    if (plan.changes.length === 0 && plan.portable.state === 'absent'
      && plan.receipt.blockers.length === 0) return finish(receipt, plan.options, plan.portable);
    if (execution.yes !== true && plan.options.yes !== true) {
      receipt.blockers.push(diagnostic('operationReviewRequired'));
      return finish(receipt, plan.options, plan.portable);
    }
    const freshContext = await createScopeContext({ scope: plan.options.scope,
      cwd: plan.context.callerCwd, env: plan.context.env });
    const environmentStable = freshContext.awHome === plan.context.awHome
      && freshContext.generationRoot === plan.context.generationRoot
      && freshContext.projectKey === plan.context.projectKey
      && JSON.stringify(freshContext.targetHomes) === JSON.stringify(plan.context.targetHomes);
    await freshContext.dispose();
    const executionCwdStable = plan.options.scope !== 'user'
      || await assertNeutralAncestorChain(plan.context.executionCwd)
        .then((value) => value === plan.context.executionCwd, () => false);
    if (!environmentStable || !executionCwdStable) {
      receipt.blockers.push(diagnostic('operationReviewStale'));
      return finish(receipt, plan.options, plan.portable);
    }
    return await withAwHomeMutationLock({ env: plan.context.env, token: runtime.awHomeMutationToken,
      action: async (token) => {
        if (receipt.blockers.some((entry) => blocksStrongRetirement(entry.code, plan.options.deleteConfig === true))) {
          return finish(receipt, plan.options, plan.portable);
        }
        const location = { scope: plan.options.scope, cwd: plan.context.executionCwd, env: plan.context.env, token };
        const [intent, preferences] = await Promise.all([observeIntent(location), observePreferences(location)]);
        if (evidence(intent) !== plan.intentEvidence || evidence(preferences) !== plan.preferenceEvidence) {
          receipt.blockers.push(diagnostic('operationReviewStale'));
          return finish(receipt, plan.options, plan.portable);
        }
        const inventory = await (runtime.inventoryCatalogSourceReferences ?? inventoryCatalogSourceReferences)({
          cwd: plan.context.executionCwd, env: plan.context.env, scope: plan.options.scope,
          includeProjectAgentSkills: true,
        });
        const current = await inspectRemovedPluginCleanup({ pluginId: plan.options.selector, scope: plan.options.scope,
          inventory, cwd: plan.context.executionCwd, env: plan.context.env,
          nativeCliRunner: runtime.nativeCliRunner ?? getDefaultNativeCliRunner(), codexManager: runtime.codexManager });
        if (!current || !plan.evidence || current.sourceIdentity !== plan.evidence.sourceIdentity
          || current.logicalIdentity !== plan.evidence.logicalIdentity
          || current.snapshotDigest !== plan.evidence.snapshotDigest
          || current.projectionFingerprint !== plan.evidence.projectionFingerprint
          || current.marketplaceEvidenceFingerprint !== plan.evidence.marketplaceEvidenceFingerprint
          || current.nativeObservationFingerprint !== plan.evidence.nativeObservationFingerprint
          || JSON.stringify(current.configTargets) !== JSON.stringify(plan.evidence.configTargets)
          || JSON.stringify(current.evidence) !== JSON.stringify(plan.evidence.evidence)) {
          receipt.blockers.push(diagnostic('operationReviewStale'));
          return finish(receipt, plan.options, plan.portable);
        }
        const portable = await inspectPortableResidue({ scope: plan.options.scope, context: plan.context,
          selector: plan.options.selector, env: plan.context.env, agents: plan.options.targets === undefined
            ? undefined : plan.receipt.selection.agents }).catch(() => undefined);
        if (!portable || JSON.stringify(portable) !== JSON.stringify(plan.portable)) {
          receipt.blockers.push(diagnostic('operationReviewStale'));
          return finish(receipt, plan.options, plan.portable);
        }
        const refreshIntent = async () => {
          const refreshed = await observeIntent(location);
          receipt.intent = { state: refreshed.state, ...('digest' in refreshed ? { digest: refreshed.digest } : {}),
            roots: refreshed.state === 'valid' ? refreshed.value.roots.map((root) => root.pluginId)
              : refreshed.state === 'absent' ? [] : null };
        };
        try {
          if (intent.state === 'valid' && intent.value.roots.some((root) => root.pluginId === plan.options.selector)) {
            const result = await removeRoot(location, plan.options.selector);
            receipt.declarationChanged = result.changed;
          }
          if (preferences.state === 'valid') {
            const next = preferences.value.dependencyScopeOverrides.filter((entry) => entry.pluginId !== plan.options.selector);
            if (next.length !== preferences.value.dependencyScopeOverrides.length) {
              const result = await writePreferences(location, { ...preferences.value, dependencyScopeOverrides: next });
              receipt.preferencesChanged = result.changed;
            }
          }
          if (plan.options.deleteConfig && plan.evidence) {
            const result = await resetPluginConfigStore({ sourceId: plan.evidence.sourceId,
              sourceIdentity: plan.evidence.sourceIdentity, pluginName: plan.evidence.pluginName,
              scope: plan.options.scope, cwd: plan.context.executionCwd, env: plan.context.env });
            receipt.configChanged = result.deleted;
            configDeletionCompleted = true;
          }
        } catch (error) {
          receipt.blockers.push(diagnostic(codeOf(error, 'retireConfigurationFailed')));
          await refreshIntent();
          return finish(receipt, plan.options, plan.portable);
        }
        await refreshIntent();
        if (plan.evidence) {
          const selectedTargets = receipt.targetResults.flatMap((target) => target.delivery?.kind === 'native'
            ? [{ pluginId: target.pluginId, platform: target.delivery.platform, scope: target.scope }] : []);
          if (selectedTargets.length) {
            try {
              const result = await executeRemovedPluginOutputCleanup({ target: plan.evidence, selectedTargets,
                context: plan.context, runtime: { ...runtime, awHomeMutationToken: token } });
              receipt.outputsMayHaveChanged = result.rebuildResults.some((entry) => entry.actions.length > 0);
              let partialAttributed = false;
              for (const target of receipt.targetResults.filter((entry) => entry.delivery?.kind === 'native')) {
                const platform = target.delivery?.kind === 'native' ? target.delivery.platform : undefined;
                const backendTargets = result.targetResults.filter((entry) => entry.target.pluginId === target.pluginId
                  && entry.target.scope === target.scope && entry.target.platform === platform);
                const rebuildTargets = result.rebuildResults.filter((entry) => entry.target.pluginId === target.pluginId
                  && entry.target.scope === target.scope && entry.target.platform === platform);
                const failed = backendTargets.some((entry) => entry.state === 'failed');
                const sharedNativePreserved = platform === 'codex'
                  && result.warnings.some((warning) => warning.startsWith('sharedNativePreserved:'));
                const preserved = backendTargets.some((entry) => entry.action === 'keep')
                  || rebuildTargets.some((entry) => entry.residual.length > 0 || entry.quarantined.length > 0)
                  || sharedNativePreserved;
                target.execution = failed ? 'failed' : backendTargets.length ? 'applied' : 'no-op';
                target.observation = failed ? 'unknown' : target.content === 'absent' ? 'missing' : 'unknown';
                target.backend = backendTargets.map((entry) => ({
                  target: { pluginId: entry.target.pluginId, platform: entry.target.platform,
                    scope: entry.target.scope }, action: entry.action, state: entry.state,
                  ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
                }));
                if (failed) target.blockers.push(diagnostic('nativeRetireFailed'));
                else if (preserved) target.blockers.push(diagnostic('sharedNativePreserved'));
                partialAttributed ||= failed || preserved;
              }
              if (result.overallState === 'partial' && !partialAttributed) {
                receipt.blockers.push(diagnostic('nativeRetirePartial'));
              }
            } catch (error) {
              for (const target of receipt.targetResults.filter((entry) => entry.delivery?.kind === 'native')) {
                target.execution = 'failed'; target.blockers.push(diagnostic(codeOf(error, 'nativeRetireFailed')));
              }
            }
          }
        }
        if (portable.state === 'unknown' && !receipt.targetResults.some((target) =>
          target.blockers.some((entry) => entry.code === 'portableObservationFailed'))) {
          receipt.blockers.push(diagnostic('portableObservationFailed'));
        }
        return finish(receipt, plan.options, plan.portable, configDeletionCompleted);
      } });
  } finally { await plan.context.dispose(); }
}

export async function runRetire(options: RetireOptions, runtime: RebuildCommandRuntime = {}): Promise<RecoveryReceipt> {
  const plan = await prepareRetire(options, runtime);
  if (options.interactive && options.yes !== true && options.prompt?.confirm && plan.changes.length) {
    const response = await options.prompt.confirm({ defaultValue: false,
      message: [...plan.changes, ...plan.warnings, '是否执行以上停用步骤？'].join('\n') });
    if (response.cancelled || response.value !== true) {
      plan.receipt.blockers.push(diagnostic('operationCancelled'));
      await plan.context.dispose();
      return finish(plan.receipt, plan.options, plan.portable);
    }
    return executeRetire(plan, { yes: true });
  }
  return executeRetire(plan);
}
