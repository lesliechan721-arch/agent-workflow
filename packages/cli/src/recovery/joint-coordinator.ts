import { getCommandPackageId } from '@lesliechan721/aw-plugin-core/manifest';
import type { Scope } from '../types.js';
import type { RebuildCommandRuntime } from '../commands/rebuild-command.js';
import { addRequirements } from '../commands/intent-command.js';
import { createEmptyIntent, calculateIntentDigest, removeIntentRoot, type PluginIntent } from '../intent/intent-codec.js';
import { observeIntent, writeIntent, resolveIntentPath, type IntentObservation } from '../intent/intent-store.js';
import { describeStrongStateProblem } from '../intent/diagnostics.js';
import { observePreferences, normalizeAgents } from '../intent/deployment-preferences.js';
import { createScopeContext } from '../intent/scope-context.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { readSafeOperationError } from '../utils/safe-operation-diagnostic.js';
import { createCodexNativeObservationSession } from '../utils/codex-native-observation.js';
import { getDefaultNativeCliRunner } from '../utils/native-cli.js';
import { analyzeCodexSurface } from '../utils/codex-surface-analysis.js';
import { validateCatalogSnapshotComplete } from '../utils/catalog-snapshot.js';
import { readCatalogGenerationState } from '../utils/catalog-generation-state.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { readDemand, type DemandSnapshot } from './demand.js';
import { readJointDemand, deriveJointDemand, findPlacementConflicts, targetsConflict, type JointDemandSnapshot, type JointDemandPlan } from './joint-demand.js';
import { prepareScopedRecovery, executeScopedRecovery, executeRecoveryPreApply, describeRecoveryPlan, type RecoveryCommand, type RecoveryOptions, type RecoveryPlan } from './coordinator.js';
import { readScopedRecoveryStatus, readRecoveryStatus } from './status.js';
import type { RecoveryReceipt, RecoveryDiagnostic } from './receipt.js';

export interface JointRecoveryState {
  snapshot: JointDemandSnapshot;
  demand: JointDemandPlan;
  children: RecoveryPlan[];
  originalOptions: RecoveryOptions;
  selectors: string[];
  declaration?: { scope: Scope; value: PluginIntent };
  evidence: string;
}
const diagnostic = (code: string, message = code): RecoveryDiagnostic => ({ code, message });
function intentReceipt(observation: IntentObservation): RecoveryReceipt['intent'] {
  return { state: observation.state,
    roots: observation.state === 'valid' ? observation.value.roots.map((root) => root.pluginId)
      : observation.state === 'absent' ? [] : null,
    ...('digest' in observation ? { digest: observation.digest } : {}),
  };
}

const observationEvidence = (value: IntentObservation | Awaited<ReturnType<typeof observePreferences>>): string =>
  'rawDigest' in value ? `${value.state}:${value.rawDigest}` : value.state;
function snapshotEvidence(snapshot: JointDemandSnapshot): string {
  return JSON.stringify([observationEvidence(snapshot.user.intent),
    snapshot.project ? observationEvidence(snapshot.project.intent) : null,
    observationEvidence(snapshot.user.preferences), snapshot.user.catalogOperationContext?.generationSetDigest,
    snapshot.project?.catalogOperationContext?.generationSetDigest]);
}
function asObservation(value: PluginIntent): IntentObservation {
  const rawBytes = Buffer.from(JSON.stringify(value));
  return { state: 'valid', value, digest: calculateIntentDigest(value), rawDigest: calculateIntentDigest(value), rawBytes };
}
function mergeReceipts(plan: RecoveryPlan, receipts: RecoveryReceipt[]): RecoveryReceipt {
  const receipt = structuredClone(plan.receipt);
  receipt.targetResults = receipts.flatMap((item) => item.targetResults);
  for (const root of plan.joint?.demand.roots ?? []) {
    if (!receipt.requestedRoots.includes(root.pluginId) || !receipt.selection.agents.includes(root.target)
      || !['unsupported', 'excluded'].includes(root.state)) continue;
    receipt.targetResults.push({ pluginId: root.pluginId, agent: root.target, scope: root.scope,
      requirementScope: root.scope, delivery: null, execution: 'no-op', observation: 'verified', content: 'satisfied',
      satisfaction: root.state as 'unsupported' | 'excluded', requiredBy: [root.pluginId], blockers: [],
      ...(root.reasons?.length ? { reasons: root.reasons } : {}) });
  }
  receipt.requestedTargets = receipt.targetResults.map(({ pluginId, agent, scope, delivery }) => ({ pluginId, agent, scope, delivery }));
  for (const target of receipt.targetResults) {
    const placement = plan.joint?.demand.placements.find((item) => item.pluginId === target.pluginId && item.target === target.agent);
    if (placement) {
      target.requiredBy = [...new Set(placement.contributions.map((item) => item.root))];
      target.providerScope = placement.scope;
    }
  }
  receipt.remainingTargets = receipts.flatMap((item) => item.remainingTargets);
  receipt.errors = [...receipt.blockers, ...receipts.flatMap((item) => [...item.blockers, ...item.errors])];
  receipt.outputsMayHaveChanged = receipts.some((item) => item.outputsMayHaveChanged);
  receipt.commandResults = receipts.flatMap((item) => item.commandResults ?? []);
  receipt.nativeToolChanges = receipts.flatMap((item) => item.nativeToolChanges ?? []);
  receipt.recoveryActions = [...new Set(receipts.flatMap((item) => item.recoveryActions))];
  receipt.ok = receipt.blockers.length === 0 && receipts.every((item) => item.ok);
  return receipt;
}

/** Complete requirements determine placement before execution selectors are applied. */
export async function prepareJointRecovery(command: RecoveryCommand, selectors: readonly string[],
  options: RecoveryOptions, runtime: RebuildCommandRuntime): Promise<RecoveryPlan> {
  const snapshot = await readJointDemand(options);
  if (runtime.codexObservationSession) return prepareJointRecoveryInSession(command, selectors, options, runtime, snapshot);
  const observationContext = await createScopeContext({ ...options, scope: snapshot.context.context });
  const session = await createCodexNativeObservationSession({ exactCwd: observationContext.executionCwd,
    env: observationContext.env, runner: runtime.nativeCliRunner ?? getDefaultNativeCliRunner(), manager: runtime.codexManager });
  try {
    const plan = await prepareJointRecoveryInSession(command, selectors, options, { ...runtime, codexObservationSession: session }, snapshot);
    const dispose = plan.context.dispose;
    plan.context.dispose = async () => {
      try { await dispose(); } finally { try { await session.dispose(); } finally { await observationContext.dispose(); } }
    };
    return plan;
  } catch (error) {
    try { await session.dispose(); } finally { await observationContext.dispose(); }
    throw error;
  }
}

async function prepareJointRecoveryInSession(command: RecoveryCommand, selectors: readonly string[],
  options: RecoveryOptions, runtime: RebuildCommandRuntime, snapshot: JointDemandSnapshot): Promise<RecoveryPlan> {
  const evidence = snapshotEvidence(snapshot);
  const scope = options.scope ?? snapshot.context.context;
  const observedIntent = (scope === 'project' ? snapshot.project! : snapshot.user).intent;
  if (options.existingOnly) {
    // Existing owned deployments can be refreshed without converting them into declarations.
    const observed = await readRecoveryStatus({ ...options, nativeCliRunner: runtime.nativeCliRunner, codexObservationSession: runtime.codexObservationSession });
    const installed = (observed.existingTargets ?? []).filter((item) => selectors.some((selector) => selector === item.pluginId
        || !selector.includes('/') && parsePluginId(item.pluginId).pluginName === selector)
      && (!options.targets || options.targets.includes(item.agent)));
    if (installed.length) {
      const generations = await readCatalogGenerationState(options.env);
      for (const currentScope of snapshot.context.scopes) {
        const sourceDemand = currentScope === 'user' ? snapshot.user : snapshot.project!;
        if (sourceDemand.intent.state !== 'valid' && sourceDemand.intent.state !== 'absent') continue;
        const value = structuredClone(sourceDemand.intent.state === 'valid' ? sourceDemand.intent.value : createEmptyIntent());
        for (const item of installed.filter((item) => item.scope === currentScope)) {
          if (value.roots.some((root) => root.pluginId === item.pluginId)) continue;
          const sourceId = parsePluginId(item.pluginId).sourceId!;
          const identity = generations.sources[sourceId]?.active?.logicalIdentity;
          if (!identity) continue;
          value.sources[sourceId] = { logicalIdentity: identity };
          value.roots.push({ pluginId: item.pluginId });
        }
        snapshot = { ...snapshot, [currentScope]: await readDemand({ ...options, scope: currentScope, intent: asObservation(value) }) };
      }
      if (snapshot.preferences) snapshot.preferences = { ...snapshot.preferences,
        targets: normalizeAgents([...snapshot.preferences.targets, ...installed.map((item) => item.agent!)]) };
    }
  }
  const previousDemand = deriveJointDemand(snapshot);
  const original = scope === 'project' ? snapshot.project! : snapshot.user;
  const errors: RecoveryDiagnostic[] = [];
  let declaration: JointRecoveryState['declaration'];
  let requested = [...selectors];
  if (command === 'install') {
    if (options.targets !== undefined) errors.push(diagnostic('installTargetSelectionUnsupported', '安装使用已保存的本机 Agent。'));
    if (!snapshot.preferences?.targets.length) errors.push(diagnostic('targetsNotConfigured', '请先配置本机 Agent，再安装插件。'));
    else {
      const proposed = await addRequirements({ ...options, scope, selectors, token: runtime.awHomeMutationToken, dryRun: true, installSelectors: true });
      errors.push(...proposed.errors);
      if (proposed.state && !proposed.errors.length) {
        requested = proposed.roots;
        if (proposed.changed) declaration = { scope, value: proposed.state };
        const demand = await readDemand({ ...options, scope, intent: asObservation(proposed.state) });
        snapshot = { ...snapshot, [scope]: demand };
      }
    }
  } else if (command === 'uninstall') {
    try {
      const sourceIds = new Set((original.roots ?? []).filter((root) => selectors.some((selector) => selector === root.pluginId
        || !selector.includes('/') && parsePluginId(root.pluginId).pluginName === selector)).map((root) => root.sourceId));
      for (const sourceId of sourceIds) {
        const source = original.catalogOperationContext?.catalog.sources.find((entry) => entry.sourceId === sourceId)?.resolution;
        if (!source) throw new Error('sourceActiveUnavailable');
        await validateCatalogSnapshotComplete(source.rootDir);
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      errors.push(diagnostic('catalogSnapshotInvalid', '来源快照无法完整验证，未修改声明或输出。'));
    }
    if (original.intent.state !== 'valid' && original.intent.state !== 'absent') errors.push(diagnostic('pluginIntentStateInvalid'));
    else {
      let value = original.intent.state === 'valid' ? original.intent.value : createEmptyIntent();
      for (const selector of selectors) {
        const parsed = parsePluginId(selector);
        const matches = value.roots.filter((root) => parsed.sourceId ? root.pluginId === selector
          : parsePluginId(root.pluginId).pluginName === parsed.pluginName);
        if (matches.length !== 1) { errors.push(diagnostic('pluginIntentRootMissing')); continue; }
        requested[requested.indexOf(selector)] = matches[0]!.pluginId;
        value = removeIntentRoot(value, matches[0]!.pluginId);
      }
      if (!errors.length) {
        declaration = { scope, value };
        const demand = await readDemand({ ...options, scope, intent: asObservation(value) });
        snapshot = { ...snapshot, [scope]: demand };
      }
    }
  }
  const demand = deriveJointDemand(snapshot);
  errors.push(...demand.errors);
  const rootIds = [...new Set([...(snapshot.user.roots ?? []), ...(snapshot.project?.roots ?? [])]
    .map((root) => root.pluginId))];
  if (command !== 'install' && command !== 'uninstall') {
    requested = selectors.length ? selectors.flatMap((selector) => {
      const parsed = parsePluginId(selector);
      const matches = (options.existingOnly ? [...new Set([...rootIds, ...demand.placements.map((item) => item.pluginId)])] : rootIds).filter((id) => parsed.sourceId ? id === selector : parsePluginId(id).pluginName === parsed.pluginName);
      if (matches.length !== 1 && !options.existingOnly) errors.push(diagnostic('syncPluginNotDesired', `${selector} 未声明或名称不唯一。`));
      return matches.length === 1 ? matches : [];
    }) : rootIds;
  }
  const targets = options.targets ? normalizeAgents(options.targets) : snapshot.preferences?.targets ?? [];
  if (options.exactTargets && (!options.exactTargets.length && !options.existingOnly || options.exactTargets.some((exact) =>
    !targets.includes(exact.agent) || !demand.roots.some((root) => root.pluginId === exact.pluginId
      && requested.includes(root.pluginId) && root.target === exact.agent && (!exact.scope || root.scope === exact.scope))
    && !demand.placements.some((placement) => placement.pluginId === exact.pluginId && placement.target === exact.agent
      && (!exact.scope || placement.scope === exact.scope || placement.contributions.some((item) => item.scope === exact.scope))
      && (requested.includes(placement.pluginId) || placement.contributions.some((item) => requested.includes(item.root))))))) {
    errors.push(diagnostic('invalidExactTargets', '精确重试目标不属于当前请求，请重新检查并选择。'));
  }
  const selected = demand.placements.filter((placement) => targets.includes(placement.target)
    && !demand.conflicts.some((conflict) => [conflict.left, conflict.right].some((position) => position.target === placement.target && position.scope === placement.scope))
    && (!options.exactTargets || options.exactTargets.some((exact) => exact.agent === placement.target
      && (!exact.scope || placement.contributions.some((item) => item.scope === exact.scope))
      && (exact.pluginId === placement.pluginId || placement.contributions.some((item) => item.path.includes(exact.pluginId)))))
    && (command === 'uninstall' ? requested.includes(placement.pluginId)
      || previousDemand.placements.some((previous) => previous.pluginId === placement.pluginId && previous.target === placement.target && previous.scope !== placement.scope)
      : placement.contributions.some((item) => requested.includes(item.root)) || options.existingOnly && requested.includes(placement.pluginId)));
  const activationOnlyTargets: NonNullable<RecoveryOptions['nativeActivationOnlyTargets']> = [];
  if (snapshot.project && !errors.length) {
    const sharedNative = selected.filter((item) => item.scope === 'user' && (item.target === 'codex' || item.target === 'claude')
      && item.contributions.some((entry) => entry.scope === 'project'));
    if (sharedNative.length) {
      const expanded: DemandSnapshot = { ...snapshot.project, roots: [...new Map(sharedNative.map((item) => [item.pluginId, {
        pluginId: item.pluginId, sourceId: item.plugin.sourceId!, sourceState: 'ready' as const, blockers: [], plugin: item.plugin,
      }])).values()], userProviders: Object.fromEntries(targets.map((target) => [target,
        demand.placements.filter((item) => item.scope === 'user' && item.target === target).map((item) => item.pluginId)])) };
      const observation = await readScopedRecoveryStatus({ ...options, nativeCliRunner: runtime.nativeCliRunner, codexObservationSession: runtime.codexObservationSession, scope: 'project', demandOverride: expanded,
        cwd: snapshot.context.projectRoot!, targets: undefined });
      for (const item of sharedNative) {
        const actual = observation.inventory?.find((entry) => entry.pluginId === item.pluginId)?.targetResults
          .find((entry) => entry.agent === item.target);
        if (item.target === 'codex') {
          const surface = analyzeCodexSurface(item.plugin.manifest);
          const live = (actual?.backend as { live?: { components?: Array<{ kind: string; key: string; state: string }> } } | undefined)?.live;
          const explicitlyDisabled = live?.components?.some((component) => component.kind === 'activation'
            && component.key === 'project' && component.state === 'disabled');
          const userProvidesComponents = surface.components.every((component) => !component.scopes.includes('project') || component.scopes.includes('user'));
          const retiringProjectComponents = live?.components?.some((component) => component.kind === 'ownership'
            && component.key !== 'native' && !component.key.startsWith('activation-') && !component.key.startsWith('marketplace-')
            && ['present', 'partial'].includes(component.state));
          if (userProvidesComponents) {
            if (!surface.nativeKinds.length || !explicitlyDisabled && !retiringProjectComponents) continue;
            activationOnlyTargets.push({ pluginId: item.pluginId, platform: 'codex', scope: 'project' });
            selected.push({ ...item, scope: 'project' });
            continue;
          }
        }
        if (actual?.content !== 'satisfied') {
          if (item.target === 'claude') activationOnlyTargets.push({ pluginId: item.pluginId, platform: 'claude', scope: 'project' });
          selected.push({ ...item, scope: 'project' });
        }
      }
    }
  }
  const context = await createScopeContext({ ...options, scope });
  const baseDemand = scope === 'project' ? snapshot.project! : snapshot.user;
  const receipt: RecoveryReceipt = {
    schemaVersion: 1, kind: 'aw-recovery', command, scope, ok: false,
    intent: intentReceipt(observedIntent),
    requestedRoots: requested, requestedTargets: [], remainingTargets: [], targetResults: [],
    selection: { agents: targets, origin: options.targets ? 'argument' : targets.length ? 'preference' : 'none', preferences: snapshot.user.preferences.state },
    blockers: errors, errors, recoveryActions: [], declarationChanged: false, preferencesChanged: false,
    configChanged: false, outputsMayHaveChanged: false,
    coverage: { scopes: snapshot.context.scopes, ...(snapshot.context.projectRoot ? { projectRoot: snapshot.context.projectRoot } : {}) },
  };
  const children: RecoveryPlan[] = [];
  const joint: JointRecoveryState = { snapshot, demand, children, originalOptions: options,
    selectors: [...selectors], declaration, evidence };
  const plan: RecoveryPlan = { command, options: { ...options, scope }, receipt, context, demand: baseDemand,
    originalIntent: observationEvidence(original.intent), preferencesEvidence: observationEvidence(snapshot.user.preferences),
    plannedImpact: { declaration: Boolean(declaration), preferences: false, config: false, outputs: false },
    changes: declaration ? [`保存 ${scope} 插件需求。`] : [], warnings: [], nativeGroups: [],
    historicalNativeTargets: new Set(), deliverySwitchChecks: [], portableGroups: [], portableProtectionGroups: [],
    portableResidues: [], sourceRefreshes: [], sourceRefreshFailures: [], runtime, blockExecution: errors.some((error) => ['syncPluginNotDesired', 'pluginIntentRootMissing', 'pluginIntentStateInvalid', 'catalogSnapshotInvalid', 'installTargetSelectionUnsupported', 'invalidExactTargets'].includes(error.code)
      || error.code === 'targetsNotConfigured' && !options.retireUnselectedTargets)
      || !snapshot.preferences || snapshot.user.roots === null || snapshot.project?.roots === null, joint };
  const dispose = context.dispose;
  context.dispose = async () => { await Promise.all(children.map((child) => child.context.dispose())); await dispose(); };
  if (plan.blockExecution) return plan;
  try {
    const currentStatus = await readRecoveryStatus({ ...options, nativeCliRunner: runtime.nativeCliRunner,
      codexObservationSession: runtime.codexObservationSession, targets: undefined });
    // Native platforms share one complete marketplace candidate per scope.
    const nativeTargets = targets.filter((target) => target === 'codex' || target === 'claude');
    const targetGroups: Array<typeof targets> = [...(nativeTargets.length ? [nativeTargets] : []),
      ...targets.filter((target) => target !== 'codex' && target !== 'claude').map((target) => [target])];
    for (const currentScope of snapshot.context.scopes) {
      for (const groupTargets of targetGroups) {
        const placements = selected.filter((item) => item.scope === currentScope && groupTargets.includes(item.target)
          && !(command === 'install' && scope === 'project' && currentScope === 'user'
            && currentStatus.observedTargets?.some((observed) => observed.pluginId === item.pluginId
              && observed.agent === item.target && observed.scope === 'user' && observed.content === 'satisfied')));
        if (!placements.length) continue;
        const sourceDemand = currentScope === 'project' ? snapshot.project! : snapshot.user;
        const childPlacements = [
          ...demand.placements.filter((item) => item.scope === currentScope && groupTargets.includes(item.target)),
          ...placements,
        ];
        const userProviders = demand.placements.filter((item) => item.scope === 'user' && groupTargets.includes(item.target));
        const childDemand: DemandSnapshot = { ...sourceDemand,
          targetRequirements: childPlacements.map((item) => ({ pluginId: item.pluginId, target: item.target })),
          userProviders: Object.fromEntries(groupTargets.map((target) => [target, userProviders
            .filter((item) => item.target === target).map((item) => item.pluginId)])),
          roots: [...new Map(childPlacements.map((item) => [item.pluginId, { pluginId: item.pluginId, sourceId: item.plugin.sourceId!,
              sourceState: 'ready' as const, blockers: [], plugin: item.plugin }])).values()] };
        const child = await prepareScopedRecovery(command === 'reinstall' ? 'reinstall' : 'sync',
          [...new Set(placements.map((item) => item.pluginId))], { ...options, scope: currentScope, targets: groupTargets, all: false,
            cwd: snapshot.context.projectRoot ?? options.cwd, demandOverride: childDemand,
            exactTargets: placements.map((item) => ({ pluginId: item.pluginId, agent: item.target })),
            nativeActivationOnlyTargets: activationOnlyTargets.filter((item) => item.scope === currentScope
              && placements.some((placement) => placement.pluginId === item.pluginId && placement.target === item.platform)),
            nativePlannedRetirements: command === 'uninstall' && currentScope === 'project'
              ? placements.filter((item) => item.target === 'codex'
                && currentStatus.ownedTargets?.some((owned) => owned.pluginId === item.pluginId && owned.agent === item.target && owned.scope === 'user')
                && !demand.placements.some((provider) => provider.pluginId === item.pluginId && provider.target === item.target && provider.scope === 'user'))
                .map((item) => ({ pluginId: item.pluginId, platform: 'codex' as const, scope: 'user' as const })) : [],
            excludedPluginIds: currentScope === 'project' ? userProviders.map((item) => item.pluginId) : [],
            dependencyScopeOverrides: currentScope === 'project'
              ? userProviders.filter((provider) => (provider.target === 'codex' || provider.target === 'claude')
                && !placements.some((item) => item.pluginId === provider.pluginId && item.target === provider.target))
                .map((item) => ({ pluginId: item.pluginId, platform: item.target as 'codex' | 'claude', scope: 'user' as const })) : [],
          }, runtime);
        // Synthetic roots are only an execution projection, never persisted Intent.
        child.originalIntent = observationEvidence(sourceDemand.intent);
        if (options.existingOnly) {
          const observed = await readScopedRecoveryStatus({ ...options, nativeCliRunner: runtime.nativeCliRunner, codexObservationSession: runtime.codexObservationSession, scope: currentScope,
            cwd: snapshot.context.projectRoot ?? options.cwd, demandOverride: childDemand, targets: groupTargets });
          for (const item of child.receipt.targetResults) {
            if (!observed.existingTargets?.some((existing) => existing.pluginId === item.pluginId && existing.agent === item.agent && existing.scope === currentScope)) {
              item.blockers.push(diagnostic('configApplyRequiresExistingOutput', '输出缺失或不可确认，请先运行 sync。'));
            }
          }
        }
        children.push(child);
      }
    }
    const portableCandidates = children.flatMap((child) => child.portableGroups.flatMap((prepared) => prepared.targets
      .filter((target) => target.disposition !== 'remove')
      .map((target) => ({ child, prepared, target }))));
    for (const [index, left] of portableCandidates.entries()) for (const right of portableCandidates.slice(index + 1)) {
      if (left.child.options.scope === right.child.options.scope || left.target.agent !== right.target.agent
        || left.target.skill !== right.target.skill) continue;
      const conflict = diagnostic('crossScopeSkillCollision', `${left.target.providerPluginId}@${left.child.options.scope} (${left.target.physicalPath}) 与 ${right.target.providerPluginId}@${right.child.options.scope} (${right.target.physicalPath}) 占用同一 Agent Skill 名。`);
      for (const item of [left, right]) {
        item.child.receipt.targetResults.find((target) => target.pluginId === item.prepared.options.selector && target.agent === item.target.agent)?.blockers.push(conflict);
      }
      plan.receipt.blockers.push(conflict);
    }
    // Only explicit target exits, selected removals and provider switches retire outputs.
    // Unrelated indirect dependencies remain visible residue.
    const ownsOutput = (item: { pluginId: string; agent: string | null; scope: Scope }): boolean =>
      currentStatus.ownedTargets?.some((owned) => owned.pluginId === item.pluginId
        && owned.agent === item.agent && owned.scope === item.scope) === true;
    const requiredNativeActivation = (item: { pluginId: string; agent: string | null; scope: Scope; backend?: unknown }): boolean => {
      const backend = item.backend as { live?: { components?: Array<{ kind: string; key: string; state: string }> };
        components?: Array<{ kind: string; key: string; state: string }> } | undefined;
      const scopedExtensions = (backend?.live?.components ?? backend?.components ?? []).some((component) =>
        component.kind === 'ownership' && component.key !== 'native'
        && !component.key.startsWith('activation-') && !component.key.startsWith('marketplace-')
        && ['present', 'partial'].includes(component.state));
      if (item.scope !== 'project' || (item.agent !== 'codex' && item.agent !== 'claude')) return false;
      return demand.placements.some((placement) => {
        if (placement.pluginId !== item.pluginId || placement.target !== item.agent) return false;
        if (item.agent === 'codex' && scopedExtensions) {
          const surface = analyzeCodexSurface(placement.plugin.manifest);
          if (surface.extensionKinds.length > 0 && surface.components.every((component) =>
            !component.scopes.includes('project') || component.scopes.includes('user'))) return false;
        }
        return placement.contributions.some((contribution) => contribution.scope === 'project');
      });
    };
    for (const candidate of portableCandidates) for (const installed of currentStatus.extraObserved) {
      const backend = installed.backend as { skill?: string; logicalIdentity?: string } | undefined;
      if (installed.scope === candidate.child.options.scope || installed.agent !== candidate.target.agent
        || backend?.skill !== candidate.target.skill) continue;
      if (installed.pluginId === candidate.target.providerPluginId && backend.logicalIdentity === candidate.prepared.logicalIdentity) continue;
      const conflict = diagnostic('crossScopeSkillCollision', `${candidate.target.providerPluginId}@${candidate.child.options.scope} 与 ${installed.pluginId}@${installed.scope} 的 Skill ${candidate.target.skill} 来源不兼容。`);
      candidate.child.receipt.targetResults.find((target) => target.pluginId === candidate.prepared.options.selector && target.agent === candidate.target.agent)?.blockers.push(conflict);
      plan.receipt.blockers.push(conflict);
    }
    const retire = currentStatus.extraObserved.filter((item) => item.agent !== null && !requiredNativeActivation(item) && (
      options.retireUnselectedTargets && (!snapshot.preferences!.targets.includes(item.agent)
        || snapshot.preferences!.exclusions.some((entry) => entry.plugin === item.pluginId && entry.target === item.agent))
      || command === 'uninstall' && requested.includes(item.pluginId)
      || selected.some((placement) => placement.pluginId === item.pluginId && placement.target === item.agent && placement.scope !== item.scope
        && (item.delivery?.kind !== 'agent-skills' || (item.backend as { logicalIdentity?: string } | undefined)?.logicalIdentity === placement.plugin.catalogLogicalIdentity))
    ));
    for (const item of currentStatus.observedTargets ?? []) {
      if (ownsOutput(item) && !requiredNativeActivation(item) && selected.some((placement) => placement.pluginId === item.pluginId
        && placement.target === item.agent && placement.scope !== item.scope)
        && !demand.placements.some((placement) => placement.pluginId === item.pluginId
          && placement.target === item.agent && placement.scope === item.scope)) retire.push(item);
    }
    // A removed declaration is still present in the observed snapshot, so include its exact old outputs.
    if (command === 'uninstall') for (const item of currentStatus.inventory?.flatMap((entry) => entry.targetResults) ?? []) {
      if (!requested.includes(item.pluginId) || item.scope !== scope || !ownsOutput(item)
        || demand.placements.some((placement) => placement.pluginId === item.pluginId && placement.target === item.agent && placement.scope === item.scope)) continue;
      retire.push(item);
    }
    // Conflicting replacements are filtered before child preparation. Keep the
    // affected plugins' old outputs even when that leaves no deployment child.
    const blockedReplacementPlugins = new Set(demand.conflicts.flatMap((conflict) =>
      [...conflict.left.plugins, ...conflict.right.plugins]));
    const safeRetirements = retire.filter((item) => !blockedReplacementPlugins.has(item.pluginId));
    const retiringKeys = new Set(safeRetirements.map((item) => `${item.pluginId}\0${item.agent}\0${item.scope}`));
    const remainingPositions = currentStatus.extraObserved.filter((item) => item.agent !== null
      && !retiringKeys.has(`${item.pluginId}\0${item.agent}\0${item.scope}`))
      .map((item) => ({ pluginId: item.pluginId, target: item.agent!, scope: item.scope }));
    const remainingConflicts = findPlacementConflicts([...demand.placements, ...remainingPositions]);
    if (remainingConflicts.length) {
      plan.receipt.blockers.push(...remainingConflicts);
      for (const child of children) for (const target of child.receipt.targetResults) {
        if (remainingConflicts.some((conflict) => [conflict.left, conflict.right].some((position) => position.target === target.agent && position.scope === target.scope)))
          target.blockers.push(diagnostic('targetPlacementConflict'));
      }
    }
    const deploymentBlocked = children.some((child) => child.blockExecution
      || child.receipt.targetResults.some((item) => item.blockers.length));
    if (!plan.blockExecution && !deploymentBlocked) {
      const cleanups: RecoveryPlan[] = [];
      for (const item of [...new Map(safeRetirements.map((entry) => [`${entry.pluginId}\0${entry.agent}\0${entry.scope}`, entry])).values()]) {
        if (!item.agent) continue;
        const cleanupDemand = item.scope === 'project' ? { ...snapshot.project!,
          userProviders: Object.fromEntries((snapshot.preferences?.targets ?? []).map((target) => [target,
            demand.placements.filter((placement) => placement.scope === 'user' && placement.target === target)
              .map((placement) => placement.pluginId)])),
        } : snapshot.user;
        const cleanup = await prepareScopedRecovery('cleanup', [item.pluginId], { ...options,
          scope: item.scope, cwd: snapshot.context.projectRoot ?? options.cwd, targets: [item.agent], all: false,
          exactTargets: undefined, demandOverride: cleanupDemand }, runtime);
        cleanups.push(cleanup);
      }
      children.unshift(...cleanups);
    }
    plan.sourceRefreshes = [...new Map(children.flatMap((child) => child.sourceRefreshes).map((item) => [item.sourceId, item])).values()];
    plan.sourceRefreshFailures = [...new Map(children.flatMap((child) => child.sourceRefreshFailures).map((item) => [item.sourceId, item])).values()];
    plan.changes.push(...children.flatMap((child) => child.changes));
    plan.warnings.push(...children.flatMap((child) => child.warnings));
    plan.plannedImpact.outputs = children.some((child) => child.plannedImpact.outputs);
    plan.receipt = mergeReceipts(plan, children.map((child) => child.receipt));
    const observedManager = children.flatMap((child) => child.nativeGroups)
      .map((group) => group.preview.codexManagerPreview)
      .find((entry) => entry?.state === 'system' || entry?.state === 'cached');
    if (observedManager?.state === 'system' || observedManager?.state === 'cached') {
      runtime.codexObservationSession?.setManager(observedManager.manager);
    }
    return plan;
  } catch (error) { await context.dispose(); throw error; }
}

export async function executeJointRecovery(plan: RecoveryPlan,
  execution: { yes?: boolean; runtime?: RebuildCommandRuntime }): Promise<RecoveryReceipt> {
  const joint = plan.joint!;
  try {
    if (plan.sourceRefreshes.length) {
      plan.receipt.blockers.push(diagnostic('sourceRefreshConfirmationRequired'));
      return mergeReceipts(plan, joint.children.map((child) => child.receipt));
    }
    return await withAwHomeMutationLock({ env: plan.options.env, token: execution.runtime?.awHomeMutationToken ?? plan.runtime.awHomeMutationToken,
      action: async (token) => {
        const actual = await readJointDemand(joint.originalOptions);
        const currentIntent = (plan.options.scope === 'project' ? actual.project! : actual.user).intent;
        plan.receipt.intent = intentReceipt(currentIntent);
        if (currentIntent.state !== 'valid' && currentIntent.state !== 'absent') {
          plan.receipt.blockers.push(describeStrongStateProblem({ kind: 'intent', scope: plan.options.scope,
            state: currentIntent.state, filePath: await resolveIntentPath(plan.options) }));
        }
        if (snapshotEvidence(actual) !== joint.evidence) {
          plan.receipt.blockers.push(diagnostic('operationReviewStale')); return mergeReceipts(plan, []);
        }
        if (plan.blockExecution) return plan.receipt;
        // Recheck all backend candidates before any strong-state or output write.
        (execution.runtime?.codexObservationSession ?? plan.runtime.codexObservationSession)?.invalidate();
        const checked = await prepareJointRecovery(plan.command, joint.selectors, joint.originalOptions,
          { ...plan.runtime, ...execution.runtime, awHomeMutationToken: token });
        const stable = !checked.blockExecution && JSON.stringify(describeRecoveryPlan(plan)) === JSON.stringify(describeRecoveryPlan(checked));
        await checked.context.dispose();
        if (!stable) { plan.receipt.blockers.push(diagnostic('operationReviewStale')); return mergeReceipts(plan, []); }
        if (joint.declaration) {
          const saved = await writeIntent({ ...plan.options, scope: joint.declaration.scope, token }, joint.declaration.value);
          plan.receipt.declarationChanged = saved.changed;
          const committed = await observeIntent({ ...plan.options, scope: joint.declaration.scope });
          plan.receipt.intent = intentReceipt(committed);
          if (committed.state !== 'valid') {
            plan.receipt.blockers.push(committed.state === 'absent'
              ? diagnostic('pluginIntentStateUnavailable', '保存后未找到插件声明，未执行输出变更。')
              : describeStrongStateProblem({ kind: 'intent', scope: joint.declaration.scope,
                state: committed.state, filePath: await resolveIntentPath({ ...plan.options, scope: joint.declaration.scope }) }));
            return mergeReceipts(plan, []);
          }
        }
        const results: RecoveryReceipt[] = joint.children.filter((child) => child.blockExecution
          && child.receipt.requestedTargets.length === 0).map((child) => child.receipt);
        const failedProviders = new Set<string>();
        const failedPackages = new Set<string>();
        const failedNodes = new Set<string>();
        const packageResults: NonNullable<RecoveryReceipt['commandResults']> = [];
        const runtime: RebuildCommandRuntime = { ...plan.runtime, ...execution.runtime, awHomeMutationToken: token };
        runtime.preApplyExecutionCache ??= new Map();
        runtime.managedCommandProducerCache ??= new Map();
        const packages = runtime.configApplyPackages;
        const failedCleanups: Array<{ pluginId: string; agent: import('../intent/deployment-preferences.js').AgentId; scope: Scope }> = [];
        const executeChild = async (child: RecoveryPlan, pluginIds: string | string[], agent: import('../intent/deployment-preferences.js').AgentId): Promise<RecoveryReceipt> => {
          const currentIntent = await observeIntent(child.options);
          if (!joint.originalOptions.existingOnly) child.demand.intent = currentIntent;
          const fresh = await prepareScopedRecovery(child.command, typeof pluginIds === 'string' ? [pluginIds] : pluginIds, {
            ...child.options, targets: agent === 'codex' || agent === 'claude' ? child.options.targets : [agent], all: false,
            exactTargets: child.options.exactTargets?.filter((target) => (typeof pluginIds === 'string' ? [pluginIds] : pluginIds).includes(target.pluginId)),
          }, runtime);
          fresh.originalIntent = observationEvidence(currentIntent);
          for (const target of fresh.receipt.targetResults) {
            const reviewed = child.receipt.targetResults.find((entry) => entry.pluginId === target.pluginId && entry.agent === target.agent);
            // Native/provider observations are refreshed after preceding nodes.
            // Keep only joint constraints and an already failed script gate.
            target.blockers.push(...(reviewed?.blockers ?? []).filter((error) => reviewed?.execution === 'failed'
              || ['configApplyRequiresExistingOutput', 'crossScopeSkillCollision', 'targetPlacementConflict',
                'preApplyAuthorizationRequired', 'nativeToolAuthorizationRequired', 'providerSwitchPreApplyFailed'].includes(error.code)));
            if (reviewed?.execution === 'failed') target.execution = 'failed';
            if (child.command !== 'cleanup' && failedCleanups.some((failed) =>
              targetsConflict({ target: failed.agent, scope: failed.scope }, { target: target.agent, scope: target.scope })
              || failed.agent === target.agent && (failed.pluginId === target.pluginId || joint.demand.roots.some((root) =>
                root.pluginId === target.pluginId && root.target === target.agent && root.dependencies.includes(failed.pluginId))))) {
              target.blockers.push(diagnostic('providerSwitchCleanupFailed'));
            }
            const dependencies = joint.demand.placements.filter((placement) => placement.target === target.agent
              && placement.contributions.some((contribution) => contribution.path.includes(target.pluginId)));
            if (failedPackages.has(`${target.pluginId}\0${target.scope}`) || failedPackages.has(`${target.pluginId}\0user`)
              || dependencies.some((item) => failedPackages.has(`${item.pluginId}\0${item.scope}`))) {
              target.blockers.push(diagnostic('commandPackageProviderNotSatisfied'));
            }
            const failedDependency = dependencies.find((placement) => failedProviders.has(`${placement.pluginId}\0${placement.target}\0${placement.scope}`));
            if (failedDependency) {
              target.blockers.push(diagnostic(target.scope === 'project' && failedDependency.scope === 'user'
                ? 'userProviderNotSatisfied' : 'dependencyApplyFailed',
              `依赖提供者未完成。恢复后重试 aw plugin sync ${target.pluginId} --context ${target.scope} --target ${target.agent} --yes`));
            }
          }
          const result = await executeScopedRecovery(fresh, { ...execution, runtime });
          if (joint.originalOptions.existingOnly) for (const target of result.targetResults) {
            if (!target.blockers.some((error) => error.code === 'dependencyInstallFailed')) continue;
            target.blockers = target.blockers.map((error) => error.code === 'dependencyInstallFailed'
              ? diagnostic('dependencyApplyFailed', `依赖提供者未完成。恢复后重试 aw plugin sync ${target.pluginId} --context ${target.scope} --target ${target.agent} --yes`)
              : error);
            if (target.execution === 'failed') target.execution = 'not-run';
          }
          results.push(result);
          return result;
        };
        // Provider changes can remove a working output. Complete the replacement's
        // authorization and scripts first, sharing the normal execution cache.
        const cleanupChildren = joint.children.filter((child) => child.command === 'cleanup');
        const replacementFailures = new Set<string>();
        for (const child of joint.children.filter((child) => child.command !== 'cleanup')) {
          for (const target of child.receipt.targetResults) {
            if (child.options.nativeActivationOnlyTargets?.some((item) => item.pluginId === target.pluginId
              && item.platform === target.agent && item.scope === target.scope)) continue;
            if (!cleanupChildren.some((cleanup) => cleanup.receipt.requestedTargets.some((old) => old.pluginId === target.pluginId))) continue;
            const failure = target.blockers[0]?.code ?? await executeRecoveryPreApply({ ...child,
              options: { ...child.options, yes: execution.yes ?? plan.options.yes },
            }, target.pluginId, target.agent, runtime);
            if (!failure) continue;
            target.blockers.push(diagnostic(failure));
            if (failure !== 'preApplyAuthorizationRequired' && failure !== 'nativeToolAuthorizationRequired') target.execution = 'failed';
            replacementFailures.add(`${target.pluginId}\0${target.agent}`);
            failedProviders.add(`${target.pluginId}\0${target.agent}\0${target.scope}`);
            failedNodes.add(`${target.pluginId}\0${target.scope}`);
          }
        }
        // Target exits can replace one Agent with another. Preserve the reviewed
        // old output when its corresponding replacement cannot run.
        for (const child of joint.children.filter((child) => child.command === 'cleanup')) {
          for (const target of child.receipt.requestedTargets) {
            if ([...replacementFailures].some((failed) => failed.startsWith(`${target.pluginId}\0`)
              && (failed === `${target.pluginId}\0${target.agent}`
                || !joint.children.some((replacement) => replacement.command !== 'cleanup'
                  && replacement.receipt.requestedTargets.some((entry) => entry.pluginId === target.pluginId && entry.agent === target.agent))))) {
              child.receipt.targetResults.find((entry) => entry.pluginId === target.pluginId && entry.agent === target.agent)!
                .blockers.push(diagnostic('providerSwitchPreApplyFailed'));
            }
            const result = await executeChild(child, target.pluginId, target.agent);
            if (!result.ok) failedCleanups.push(...result.requestedTargets);
          }
        }
        interface Node {
          pluginId: string;
          scope: Scope;
          targets: Array<{ child: RecoveryPlan; agent: import('../intent/deployment-preferences.js').AgentId }>;
          packages?: NonNullable<RebuildCommandRuntime['configApplyPackages']>['targets'];
          dependencies: Set<string>;
        }
        const nodes = new Map<string, Node>();
        const nodeFor = (pluginId: string, scope: Scope): Node => {
          const key = `${pluginId}\0${scope}`;
          let node = nodes.get(key);
          if (!node) { node = { pluginId, scope, targets: [], dependencies: new Set() }; nodes.set(key, node); }
          return node;
        };
        for (const child of joint.children.filter((child) => child.command !== 'cleanup')) {
          for (const target of child.receipt.requestedTargets) nodeFor(target.pluginId, target.scope).targets.push({ child, agent: target.agent });
        }
        const hasNative = (node: Node): boolean => node.targets.some(({ agent }) => agent === 'codex' || agent === 'claude');
        for (const target of packages?.targets ?? []) {
          const sameScope = nodes.get(`${target.pluginId}\0${target.scope}`);
          const native = sameScope && hasNative(sameScope) ? sameScope
            : [...nodes.values()].find((node) => node.pluginId === target.pluginId && hasNative(node));
          const node = native ?? nodeFor(target.pluginId, target.scope);
          (node.packages ??= []).push(target);
        }
        for (const node of nodes.values()) {
          for (const { agent } of node.targets) {
            const plugin = joint.demand.placements.find((item) => item.pluginId === node.pluginId && item.target === agent)?.plugin;
            for (const name of plugin?.manifest.dependencies ?? []) {
              const pluginId = `${plugin!.sourceId}/${name}`;
              const provider = joint.demand.placements.find((item) => item.pluginId === pluginId && item.target === agent);
              if (provider) node.dependencies.add(`${pluginId}\0${provider.scope}`);
            }
          }
          if (node.scope === 'project' && nodes.has(`${node.pluginId}\0user`)) node.dependencies.add(`${node.pluginId}\0user`);
          for (const dependency of node.packages?.flatMap((item) => item.dependencies) ?? []) {
            for (const provider of nodes.values()) if (provider.pluginId === dependency) node.dependencies.add(`${dependency}\0${provider.scope}`);
          }
        }
        const pending = [...nodes.values()].sort((left, right) => left.scope === right.scope
          ? left.pluginId.localeCompare(right.pluginId) : left.scope === 'user' ? -1 : 1);
        const executedNativeChildren = new Set<RecoveryPlan>();
        const completedPackages = new Map<string, NonNullable<RecoveryReceipt['commandResults']>>();
        const recordPackages = (pluginId: string, scope: Scope, produced: NonNullable<RecoveryReceipt['commandResults']>) => {
          const key = `${pluginId}\0${scope}`;
          completedPackages.set(key, produced); packageResults.push(...produced);
          if (produced.some((result) => result.state !== 'completed')) { failedPackages.add(key); failedNodes.add(key); }
          return produced;
        };
        const applyPackages = async (pluginId: string, scope: Scope) => {
          const key = `${pluginId}\0${scope}`;
          const previous = completedPackages.get(key);
          if (previous) return previous;
          return recordPackages(pluginId, scope, await packages!.execute(pluginId, scope, token));
        };
        const blockPackages = (pluginId: string, scope: Scope, code: string) => completedPackages.get(`${pluginId}\0${scope}`)
          ?? recordPackages(pluginId, scope, packages?.blocked?.(pluginId, scope, code) ?? []);
        if (packages) runtime.nativeTargetExecution = {
          beforeApply: async (identity) => {
            const results: NonNullable<RecoveryReceipt['commandResults']> = [];
            for (const target of packages.targets.filter((target) => target.pluginId === identity.pluginId
              && (target.scope === 'user' || target.scope === identity.scope))) results.push(...await applyPackages(target.pluginId, target.scope));
            return results;
          },
          blocked: (identity, code) => packages.targets.filter((target) => target.pluginId === identity.pluginId
            && (target.scope === 'user' || target.scope === identity.scope)).flatMap((target) => blockPackages(target.pluginId, target.scope,
              code === 'dependencyInstallFailed' ? 'dependencyApplyFailed' : code)),
        };
        while (pending.length) {
          const index = pending.findIndex((node) => {
            const groups = node.targets.filter(({ child, agent }) => (agent === 'codex' || agent === 'claude') && !executedNativeChildren.has(child));
            const members = new Set([node, ...groups.flatMap(({ child }) => pending.filter((candidate) => candidate.targets.some((target) => target.child === child)))]);
            return [...members].every((member) => [...member.dependencies].every((key) =>
              !pending.some((candidate) => !members.has(candidate) && `${candidate.pluginId}\0${candidate.scope}` === key)));
          });
          if (index < 0) { plan.receipt.blockers.push(diagnostic('dependencyContractInvalid')); break; }
          const node = pending.splice(index, 1)[0]!;
          const key = `${node.pluginId}\0${node.scope}`;
          if (node.packages?.length && packages && !hasNative(node)) {
            if (failedNodes.has(key) || [...node.dependencies].some((dependency) => failedNodes.has(dependency))) {
              failedPackages.add(key); failedNodes.add(key);
              for (const target of node.packages) blockPackages(target.pluginId, target.scope, 'dependencyApplyFailed');
              plan.receipt.blockers.push(diagnostic('commandPackageProviderNotSatisfied', node.pluginId));
            } else {
              try {
                const produced: NonNullable<RecoveryReceipt['commandResults']> = [];
                for (const target of node.packages) produced.push(...await applyPackages(target.pluginId, target.scope));
                if (produced.some((result) => result.state !== 'completed')) { failedPackages.add(key); failedNodes.add(key); }
              } catch (error) {
                runtime.signal?.throwIfAborted();
                if (error instanceof Error && error.name === 'AbortError' || readSafeOperationError(error)) throw error;
                failedPackages.add(key); failedNodes.add(key);
                plan.receipt.blockers.push(diagnostic('commandPackageApplyFailed', node.pluginId));
              }
            }
          }
          for (const { child, agent } of node.targets) {
            const native = agent === 'codex' || agent === 'claude';
            if (native && executedNativeChildren.has(child)) continue;
            if (native) executedNativeChildren.add(child);
            const result = await executeChild(child, native ? child.receipt.requestedTargets.map((target) => target.pluginId) : node.pluginId, agent);
            for (const target of result.targetResults) if (target.blockers.length || !['applied', 'no-op'].includes(target.execution)) {
              failedNodes.add(`${target.pluginId}\0${target.scope}`);
              failedProviders.add(`${target.pluginId}\0${target.agent}\0${target.scope}`);
            }
          }
        }
        const receipt = mergeReceipts(plan, results);
        receipt.commandResults = [...new Map([...packageResults, ...(receipt.commandResults ?? [])]
          .map((result) => [getCommandPackageId(result.producer), result])).values()];
        receipt.recoveryActions = [...new Set([...receipt.recoveryActions,
          ...receipt.commandResults.flatMap((result) => result.recoveryActions)])];
        receipt.ok &&= failedPackages.size === 0;
        receipt.outputsMayHaveChanged ||= packageResults.some((result) => result.state === 'completed');
        receipt.errors.push(...results.flatMap((result) => result.targetResults.flatMap((target) => target.blockers)));

        const status = await readRecoveryStatus({ ...joint.originalOptions, nativeCliRunner: runtime.nativeCliRunner, codexObservationSession: runtime.codexObservationSession, targets: undefined });
        receipt.allSatisfied = status.allSatisfied;
        receipt.inSync = status.inSync;
        return receipt;
      } });
  } finally { await plan.context.dispose(); }
}
