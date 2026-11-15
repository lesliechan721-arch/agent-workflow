import { describeNativeToolClosure } from '../utils/native-tool-review.js';
import type { Scope } from '../types.js';
import type { CliPrompt } from '../commands/runtime.js';
import { operationPlanNativeToolChanges, type OperationPlan } from '../commands/operation-plan.js';
import {
  executeRemovedPluginOutputCleanup, inspectRemovedPluginCleanup,
  type RebuildCommandRuntime, type RemovedPluginCleanupTarget,
} from '../commands/rebuild-command.js';
import { bindNativeCliRunnerSignal, getDefaultNativeCliRunner } from '../utils/native-cli.js';
import { inventoryCatalogSourceReferences, type CatalogSourceReferenceInventory } from '../utils/catalog-source-references.js';
import { hasSharedUserPackage } from '../platforms/layout.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { deletePluginConfigStore } from '../utils/plugin-config.js';
import { observeIntent, removeRoot } from '../intent/intent-store.js';
import { observePreferences, writePreferences, selectAgents } from '../intent/deployment-preferences.js';
import { assertNeutralAncestorChain, createScopeContext, type ScopeContext } from '../intent/scope-context.js';
import { inspectPortableResidue, type PortableResidue } from '../portable/recovery.js';
import type { RecoveryReceipt, RecoveryTarget } from './receipt.js';
import { disposePreparedPlatformRebuildSession } from '../commands/rebuild-integration.js';

export interface RetireOptions {
  signal?: AbortSignal;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  selector: string;
  targets?: readonly string[];
  deleteConfig?: boolean;
  /** Public remove retains the local target policy. */
  preservePreferences?: boolean;
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
  operationPlan?: OperationPlan;
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
function nativeInventoryErrors(inventory: CatalogSourceReferenceInventory, pluginId: string,
  agent: RecoveryTarget['agent'], scope: Scope) {
  if (agent === 'generic') return [];
  const plugin = parsePluginId(pluginId);
  return inventory.errors.filter((error) => {
    const relevance = error.relevance;
    return !relevance.global && relevance.platform === agent && !error.kind.startsWith('config')
      && (relevance.sourceId === undefined || relevance.sourceId === plugin.sourceId)
      && (relevance.pluginName === undefined || relevance.pluginName === plugin.pluginName)
      && (relevance.scope === undefined || relevance.scope === scope
        || relevance.scope === 'user' && hasSharedUserPackage(agent));
  });
}
function retainUnobservedNativeTargets(receipt: RecoveryReceipt, inventory: CatalogSourceReferenceInventory,
  removed: RemovedPluginCleanupTarget | null): void {
  for (const target of receipt.targetResults) {
    const verified = removed?.evidence.some((entry) => entry.platform === target.agent && entry.scope === target.scope
      && entry.plan.actions.some((action) => action.recoveryCandidate?.evidence === 'verified'
        && action.recoveryCandidate.binding.plugin.sourceIdentity === removed.sourceIdentity
        && action.recoveryCandidate.binding.plugin.pluginId === target.pluginId
        && action.recoveryCandidate.binding.platform === target.agent
        && action.recoveryCandidate.binding.scope.kind === target.scope));
    // Verified candidates retain the normal cleanup path and its exact failure
    // evidence. Inventory errors fill an observation gap only without a candidate.
    if (verified) continue;
    const errors = nativeInventoryErrors(inventory, target.pluginId, target.agent, target.scope);
    if (!errors.length) continue;
    target.content = 'unknown'; target.observation = 'unknown'; target.execution = 'not-run';
    for (const error of errors) {
      const reason = diagnostic(error.kind === 'nativeNamespaceUnsafe'
        ? 'removedPluginMarketplaceProjectionUnsafe' : 'stateInventoryResidual', error.message);
      if (!target.blockers.some((entry) => entry.code === reason.code && entry.message === reason.message)) target.blockers.push(reason);
      if (!receipt.blockers.some((entry) => entry.code === reason.code && entry.message === reason.message)) receipt.blockers.push(reason);
    }
  }
}
function finish(receipt: RecoveryReceipt, options: RetireOptions, portable: PortableResidue,
  configDeletionCompleted = false): RecoveryReceipt {
  receipt.requestedTargets = receipt.targetResults.map(({ pluginId, agent, scope, delivery }) =>
    ({ pluginId, agent, scope, delivery }));
  receipt.remainingTargets = receipt.targetResults.filter((target) => target.blockers.length
    || !['applied', 'no-op'].includes(target.execution)).map(({ pluginId, agent, scope, delivery }) =>
    ({ pluginId, agent, scope, delivery }));
  const commandFailures = (receipt.commandResults ?? []).filter((result) => result.state !== 'completed');
  receipt.errors = [...receipt.blockers, ...commandFailures.flatMap((result) =>
    result.errors.length ? result.errors.map((error) => ({ ...error,
      pluginId: `${result.producer.sourceId}/${result.producer.pluginName}` }))
      : [diagnostic('managedCommandRecoveryFailed')])];
  receipt.ok = !receipt.blockers.length && !receipt.remainingTargets.length && !commandFailures.length;
  const agents = [...new Set(receipt.remainingTargets.map((target) => target.agent))];
  const retry = agents.length ? `aw plugin remove ${options.selector} --only outputs --scope ${options.scope}`
    + agents.map((agent) => ` --target ${agent}`).join('') : undefined;
  receipt.recoveryActions = [...new Set([
    ...(receipt.commandResults ?? []).flatMap((result) => result.recoveryActions),
    ...(!receipt.ok ? [...portable.targets.map((entry) =>
      `请检查并备份 Portable 目录 ${entry.physicalPath}；核验共享读取和归属后自行移开，AW 不自动删除。`),
    ...(retry ? [retry] : []),
    ...(options.deleteConfig && !configDeletionCompleted
      ? ['Review the remaining user-wide plugin configuration before requesting a new removal with --delete-config.'] : [])] : []),
  ])];
  return receipt;
}

export async function prepareRetire(options: RetireOptions, runtime: RebuildCommandRuntime = {}): Promise<RetirePlan> {
  options.signal?.throwIfAborted();
  const ownsPreparedResults = runtime.preparedArtifactRenderResults === undefined;
  const preparedResults = runtime.preparedArtifactRenderResults ?? new Map();
  runtime = { ...runtime, preparedArtifactRenderResults: preparedResults };
  const context = await createScopeContext({ scope: options.scope, cwd: options.cwd, env: options.env });
  if (ownsPreparedResults) {
    const dispose = context.dispose;
    context.dispose = async () => {
      try { await disposePreparedPlatformRebuildSession(preparedResults); } finally { await dispose(); }
    };
  }
  try {
    options.signal?.throwIfAborted();
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
    options.signal?.throwIfAborted();
    const removed = await inspectRemovedPluginCleanup({ pluginId: options.selector, scope: options.scope,
      inventory, cwd: context.executionCwd, env: context.env,
      nativeCliRunner: bindNativeCliRunnerSignal(runtime.nativeCliRunner ?? getDefaultNativeCliRunner(), options.signal),
      codexManager: runtime.codexManager });
    options.signal?.throwIfAborted();
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
      env: context.env, agents: requestedAgents?.filter((agent): agent is 'generic' => agent === 'generic'), signal: options.signal });
    options.signal?.throwIfAborted();
    const agents = requestedAgents ?? [...new Set([
      ...(removed?.evidence.map((entry) => entry.platform) ?? []),
      ...(removed && (removed.nativeState === 'installed' || removed.nativeState === 'unknown'
        || removed.projectionPresent || removed.activationScopes.length > 0) ? ['codex' as const] : []),
      ...portable.targets.map((entry) => entry.agent),
      ...(portable.unknownAgents ?? []),
      ...inventory.errors.flatMap((error) => !error.relevance.global && error.relevance.platform
        && nativeInventoryErrors(inventory, options.selector, error.relevance.platform, options.scope).includes(error)
        ? [error.relevance.platform] : []),
    ])];
    const targetResults: RecoveryTarget[] = agents.map((agent) => {
      const delivery = agent === 'generic' ? { kind: 'agent-skills' as const, provider: 'aw' as const, agentId: 'generic' as const }
        : { kind: 'native' as const, platform: agent };
      const portableUnknown = portable.unknownAgents?.some((item) => item === agent) ?? portable.state === 'unknown';
      const hasPortable = agent === 'generic' && (portableUnknown || portable.targets.some((target) => target.agent === agent));
      const hasNative = delivery.kind === 'native' && (removed?.evidence.some((entry) => entry.platform === (delivery.kind === 'native' ? delivery.platform : undefined))
        || agent === 'codex' && (removed?.nativeState === 'installed' || removed?.nativeState === 'unknown'
          || removed?.projectionPresent || (removed?.activationScopes.length ?? 0) > 0));
      return { pluginId: options.selector, agent, scope: options.scope, delivery,
        execution: 'not-run', observation: 'unknown', content: hasPortable || hasNative ? 'unknown' : 'absent',
        blockers: hasPortable ? [diagnostic(portableUnknown
          ? 'portableObservationFailed' : 'backend-action-unsupported')] : [], requiredBy: [options.selector],
        relation: 'residue', backend: { native: safeRemovedEvidence(removed?.evidence.find((entry) =>
          entry.platform === (delivery.kind === 'native' ? delivery.platform : undefined))),
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
    retainUnobservedNativeTargets(receipt, inventory, removed);
    const plannedImpact = {
      declaration: roots?.includes(options.selector) === true,
      preferences: !options.preservePreferences && preferences.state === 'valid' && preferences.value.exclusions.some((entry) =>
        entry.plugin === options.selector),
      config: options.deleteConfig === true && removed?.configTargets.some((entry) =>
        entry.scope === options.scope && entry.kind !== 'absent') === true,
      outputs: removed?.evidence.some((entry) => entry.plan.actions.length > 0
        && agents.includes(entry.platform)) === true,
    };
    const changes = [
      ...(plannedImpact.declaration ? [`删除 ${options.scope} 声明 ${options.selector}。`] : []),
      ...(plannedImpact.preferences ? [`删除此插件的本机平台排除。`] : []),
      ...(plannedImpact.config ? [`删除 ${options.scope} 已保存配置。`] : []),
      ...agents.filter((agent) => agent !== 'generic').map((agent) =>
        `检查并清理 ${options.scope}/${agent} 已验证原生输出。`),
    ];
    const preview = removed ? await executeRemovedPluginOutputCleanup({ target: removed,
      selectedTargets: targetResults.flatMap((target) => target.delivery?.kind === 'native' && !target.blockers.length
        ? [{ pluginId: target.pluginId, platform: target.delivery.platform, scope: target.scope }] : []),
      context, runtime: { ...runtime, previewOperationPlan: true,
        nativeCliRunner: bindNativeCliRunnerSignal(runtime.nativeCliRunner ?? getDefaultNativeCliRunner(), options.signal) },
    }) : undefined;
    options.signal?.throwIfAborted();
    const nativeToolChanges = preview?.operationPlan ? operationPlanNativeToolChanges(preview.operationPlan) : [];
    if (nativeToolChanges.length) receipt.nativeToolChanges = nativeToolChanges;
    for (const change of nativeToolChanges) {
      if (change.before) changes.push(...describeNativeToolClosure(change.before).map((description) =>
        `撤销原生工具 · ${change.producer.sourceId}/${change.producer.pluginName} · ${change.producer.key} · ${description}`));
    }
    for (const action of preview?.operationPlan?.actions ?? []) {
      if (action.kind !== 'retainManagedCommandPackage') continue;
      changes.push(`保留命令包 ${action.producer.key}：${action.producer.sourceId}/${action.producer.pluginName}`
        + ` · ${action.producer.scope === 'user' ? '所有项目共用' : '当前项目内共用'}`
        + ` · ${action.commandIds.length} 个命令 · ${action.availability} · ${action.recoveryAction}`);
    }
    const { signal: _signal, ...executionOptions } = options;
    return { options: executionOptions, context, evidence: removed, portable, receipt: finish(receipt, options, portable),
      intentEvidence: evidence(intent), preferenceEvidence: evidence(preferences), plannedImpact, changes,
      ...(preview?.operationPlan ? { operationPlan: preview.operationPlan } : {}),
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
        retainUnobservedNativeTargets(receipt, inventory, current);
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
            ? undefined : plan.receipt.selection.agents.filter((agent): agent is 'generic' => agent === 'generic') }).catch(() => undefined);
        if (!portable || JSON.stringify(portable) !== JSON.stringify(plan.portable)) {
          receipt.blockers.push(diagnostic('operationReviewStale'));
          return finish(receipt, plan.options, plan.portable);
        }
        if (plan.operationPlan) {
          await executeRemovedPluginOutputCleanup({ target: current,
            selectedTargets: receipt.targetResults.flatMap((target) => target.delivery?.kind === 'native' && !target.blockers.length
              ? [{ pluginId: target.pluginId, platform: target.delivery.platform, scope: target.scope }] : []),
            context: plan.context, runtime: { ...runtime, awHomeMutationToken: token,
              previewOperationPlan: true, expectedPlanFingerprint: plan.operationPlan.planFingerprint } });
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
          if (!plan.options.preservePreferences && preferences.state === 'valid') {
            const next = preferences.value.exclusions.filter((entry) => entry.plugin !== plan.options.selector);
            if (next.length !== preferences.value.exclusions.length) {
              const result = await writePreferences(location, { ...preferences.value, exclusions: next });
              receipt.preferencesChanged = result.changed;
            }
          }
          if (plan.options.deleteConfig && plan.evidence) {
            const result = await deletePluginConfigStore({ sourceId: plan.evidence.sourceId,
              sourceIdentity: plan.evidence.sourceIdentity, pluginName: plan.evidence.pluginName,
              scope: 'user', cwd: plan.context.executionCwd, env: plan.context.env });
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
          const selectedTargets = receipt.targetResults.flatMap((target) => target.delivery?.kind === 'native' && !target.blockers.length
            ? [{ pluginId: target.pluginId, platform: target.delivery.platform, scope: target.scope }] : []);
          if (selectedTargets.length || plan.operationPlan?.actions.some((action) =>
            action.kind === 'retainManagedCommandPackage')) {
            try {
              const result = await executeRemovedPluginOutputCleanup({ target: plan.evidence, selectedTargets,
                context: plan.context, runtime: { ...runtime, awHomeMutationToken: token,
                  expectedPlanFingerprint: plan.operationPlan?.planFingerprint } });
              if (result.commandResults?.length) receipt.commandResults = result.commandResults;
              receipt.outputsMayHaveChanged = result.rebuildResults.some((entry) => entry.actions.length > 0);
              let partialAttributed = result.commandResults?.some((entry) => entry.state !== 'completed') === true;
              for (const target of receipt.targetResults.filter((entry) => entry.delivery?.kind === 'native' && !entry.blockers.length)) {
                const platform = target.delivery?.kind === 'native' ? target.delivery.platform : undefined;
                const backendTargets = result.targetResults.filter((entry) => entry.target.pluginId === target.pluginId
                  && entry.target.scope === target.scope && entry.target.platform === platform);
                const rebuildTargets = result.rebuildResults.filter((entry) => entry.target.pluginId === target.pluginId
                  && entry.target.scope === target.scope && entry.target.platform === platform);
                const deployments = rebuildTargets.flatMap((entry) => entry.deploymentReceipts ?? []);
                const deploymentPlans = (result.operationPlan?.deploymentPlans ?? plan.operationPlan?.deploymentPlans ?? [])
                  .filter((entry) => entry.binding.plugin.pluginId === target.pluginId
                    && entry.binding.platform === platform && entry.binding.scope.kind === target.scope);
                if (deployments.length) target.deploymentReceipts = deployments.map((entry) => ({ ...entry,
                  products: deploymentPlans.find((candidate) => candidate.binding.id === entry.bindingId)?.binding.consumers ?? [] }));
                const nativeIncomplete = deployments.some((entry) => {
                  const expected = deploymentPlans.find((candidate) => candidate.binding.id === entry.bindingId);
                  const after = entry.after;
                  const inactive = after.consumers.every((consumer) => ['disabled', 'not-applicable'].includes(consumer.activation));
                  const unknown = after.package === 'unknown' || after.registration === 'unknown'
                    || after.ownership === 'unknown' || after.ownership === 'foreign';
                  const keptForConsumer = !unknown && inactive && expected?.evidence.sharedReferences === 'present';
                  return unknown || !inactive || !keptForConsumer
                    && (after.package === 'present' || after.registration === 'present');
                });
                const failed = backendTargets.some((entry) => entry.state === 'failed');
                const commandFailures = (result.commandResults ?? []).filter((entry) => entry.state !== 'completed'
                  && entry.producer.sourceId === plan.evidence!.sourceId
                  && entry.producer.sourceIdentity === plan.evidence!.sourceIdentity
                  && entry.producer.pluginName === plan.evidence!.pluginName
                  && entry.producer.platform === platform);
                const sharedNativePreserved = platform === 'codex'
                  && result.warnings.some((warning) => warning.startsWith('sharedNativePreserved:'));
                const preserved = rebuildTargets.some((entry) => entry.residual.length > 0 || entry.quarantined.length > 0)
                  || (deployments.length ? nativeIncomplete : backendTargets.some((entry) => entry.action === 'keep') || sharedNativePreserved);
                target.execution = failed ? 'failed' : commandFailures.length
                  ? backendTargets.length ? 'partial' : 'failed' : backendTargets.length ? 'applied' : 'no-op';
                if (!failed && nativeIncomplete) target.execution = deployments.some((entry) =>
                  entry.effects.some((effect) => effect.mutation !== 'none')) ? 'partial' : 'not-run';
                target.observation = failed || commandFailures.length ? 'unknown'
                  : target.content === 'absent' ? 'missing' : 'unknown';
                target.backend = backendTargets.map((entry) => {
                  const matching = rebuildTargets.filter((result) => result.target.pluginId === entry.target.pluginId
                    && result.target.platform === entry.target.platform && result.target.scope === entry.target.scope);
                  return { target: { pluginId: entry.target.pluginId, platform: entry.target.platform,
                    scope: entry.target.scope }, action: entry.action, state: entry.state,
                    ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
                    residual: [...new Set(matching.flatMap((result) => result.residual))],
                    quarantined: [...new Set(matching.flatMap((result) => result.quarantined))] };
                });
                if (failed) target.blockers.push(diagnostic('nativeRetireFailed'));
                else if (preserved) target.blockers.push(diagnostic('sharedNativePreserved'));
                if (deployments.some((entry) => entry.after.ownership === 'foreign')) target.blockers.push(diagnostic('deploymentOwnershipUnconfirmed'));
                if (deployments.some((entry) => entry.after.registration === 'unknown' || entry.after.package === 'unknown'
                  || entry.after.ownership === 'unknown')) target.blockers.push(diagnostic('nativeObservationUnknown'));
                const observedReasons = deployments.flatMap((entry) => [...entry.diagnostics, ...entry.after.diagnostics]);
                if (observedReasons.length) target.reasons = [...new Map(observedReasons.map((entry) =>
                  [entry.code, diagnostic(entry.code, entry.message)])).values()];
                for (const producer of commandFailures) {
                  target.blockers.push(...(producer.errors.length ? producer.errors.map((error) =>
                    diagnostic(error.code, error.message)) : [diagnostic('managedCommandRecoveryFailed')]));
                }
                partialAttributed ||= failed || preserved || commandFailures.length > 0;
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
        if (portable.state === 'unknown' && receipt.targetResults.some((target) => target.agent === 'generic')
          && !receipt.targetResults.some((target) =>
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
