import { describeNativeToolClosure } from '../utils/native-tool-review.js';
import path from 'node:path';
import { CatalogSourceInventoryIncompleteError } from '../utils/catalog-source-references.js';
import { inventoryRecoveryDiagnostic } from '../utils/inventory-recovery-diagnostic.js';
import { getCommandPackageId } from '@lesliechan721/aw-plugin-core/manifest';

import type {
  CatalogGenerationActiveV1,
  CatalogGenerationCandidateEvidence,
  CatalogSourceImpact,
  CommandProducerResult,
  InstallCommandOptions,
  PlatformName,
  PlatformSelection,
  ReceiptTargetResult,
  Scope,
} from '../types.js';
import type { CliPrompt } from '../commands/runtime.js';
import { runRebuildCommand, type PreApplyAuthorizationTarget, type RebuildCommandResult, type RebuildCommandRuntime } from '../commands/rebuild-command.js';
import { buildRebuildReceiptJson } from '../output/command-receipt.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { createCodexNativeObservationSession } from '../utils/codex-native-observation.js';
import { bindNativeCliRunnerSignal, getDefaultNativeCliRunner, prepareNativeCliExecution } from '../utils/native-cli.js';
import { portableRecoveryLayout, type PortableAgent } from '../portable/recovery-layout.js';
import { canonicalizePathThroughExistingAncestor, resolveClaudeProjectKey, resolveCodexProjectKey } from '../utils/state-paths.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { CatalogPreparationReadScope, selectCatalogOperationContext, type CatalogOperationContext } from '../utils/catalog-operation-context.js';
import { CatalogGenerationError } from '../utils/catalog-generation-error.js';
import { createCatalogPreparationStoreKey } from '../utils/catalog-generation-resolver.js';
import {
  activateCatalogSourceGeneration,
  probeCatalogSourceGeneration,
} from '../utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../utils/catalog-generation-state.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import {
  calculateCatalogSourceImpactDigest,
  inspectCatalogSourceImpact,
} from '../utils/catalog-source-impact.js';
import {
  preparePortableRecovery,
  portablePreparationDiagnostic,
  portableReviewMatches,
  unobservedPortableTarget,
  preparePortableCleanup,
  inspectPortableRecovery,
  inspectPortableResidue,
  executePortableRecovery,
  PortableInterruptedError,
  type CheckedPortableProgress,
  type PortablePreparation,
  type PortableExecutionTarget,
  type PortableResidue,
  type PortableTarget,
} from '../portable/recovery.js';
import { addRequirements } from '../commands/intent-command.js';
import { readDemand, demandNativeProjection, resolveDelivery, type DemandSnapshot } from './demand.js';
import { selectAgents, writePreferences,
  type AgentId, type DeploymentPreferences } from '../intent/deployment-preferences.js';
import { calculateIntentDigest } from '../intent/intent-codec.js';
import { observeIntent } from '../intent/intent-store.js';
import { assertNeutralAncestorChain, createScopeContext, type ScopeContext } from '../intent/scope-context.js';
import type { RecoveryDiagnostic, RecoveryReceipt, RecoveryTarget } from './receipt.js';
import { prepareJointRecovery, executeJointRecovery, type JointRecoveryState } from './joint-coordinator.js';
import { createEmptyNativeDemandView, type NativeSharedReferenceView } from '../utils/native-demand.js';
import { resolvePluginMetaDependencyClosure } from '../utils/plugin-dependencies.js';
import { runPreApplyScript } from '../utils/plugin-scripts.js';
import { readSafeOperationError } from '../utils/safe-operation-diagnostic.js';
import { RebuildInterruptedError, RecoveryInterruptedError, recoveryInterruptionCode } from './interruption.js';
import { mapInstallReads } from './install-concurrency.js';
export type { CheckedPortableProgress } from '../portable/recovery.js';
import { measureRecoveryPerformanceStage } from './performance.js';
import { disposePreparedPlatformRebuildSession } from '../commands/rebuild-integration.js';
import { operationPlanNativeToolChanges } from '../commands/operation-plan.js';

export type RecoveryCommand = 'sync' | 'install' | 'reinstall' | 'uninstall' | 'cleanup';
/** Borrowed during preparation. Returned plans must perform later checks independently. */
export interface RecoveryPreparationReads {
  catalogReadScope?: CatalogPreparationReadScope;
  portableGenerations?: Map<string, Promise<void>>;
  nativeObservationBatch?: RebuildCommandRuntime['nativeObservationBatch'];
}

export interface RecoveryOptions {
  /** Candidate target policy, committed only after the joint locked recheck. */
  preferences?: DeploymentPreferences;
  /** Read-only candidate context used before first-source activation. */
  catalogOperationContext?: import('../utils/catalog-operation-context.js').CatalogOperationContext;
  /** Compare the selected install sources before preparing deployment previews. */
  checkInstallCatalog?: (catalog: CatalogOperationContext | undefined, roots: readonly string[]) => void;
  signal?: AbortSignal;
  scope?: Scope;
  context?: Scope;
  existingOnly?: boolean;
  /** Internal precise updates may select members of the complete desired closure. */
  allowDependencySelectors?: boolean;
  keepDependencies?: boolean;
  /** Same-scope declarations selected for separate retired-plugin plans in this remove. */
  retiringCatalogRoots?: readonly string[];
  retireUnselectedTargets?: boolean;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cliVersion: string;
  targets?: readonly string[];
  all?: boolean;
  yes?: boolean;
  force?: boolean;
  refresh?: boolean;
  scriptTimeoutMs?: number;
  interactive?: boolean;
  prompt?: CliPrompt;
  exactTargets?: readonly { pluginId: string; agent: AgentId; scope?: Scope }[];
  /** Derived per-operation provider assignments, never a user preference. */
  dependencyScopeOverrides?: InstallCommandOptions['dependencyScopeOverrides'];
  demandOverride?: DemandSnapshot;
  excludedPluginIds?: string[];
  /** User generic placements required only by a selected Project root in this sync. */
  inheritedPortableProviderIds?: readonly string[];
  /** Reviewed User outputs that must still satisfy each consumer after a Project hook. */
  portableProviderChecks?: ReadonlyMap<string, readonly PortablePreparation[]>;
  /** Reviewed scoped activation work for an existing shared Native provider. */
  nativeActivationOnlyTargets?: Array<{ pluginId: string; platform: PlatformName; scope: Scope }>;
  /** Preview-only exits which are independently checked by owned cleanup plans. */
  nativePlannedRetirements?: Array<{ pluginId: string; platform: PlatformName; scope: Scope }>;
  sharedReferenceView?: NativeSharedReferenceView;
}
interface NativeTarget {
  pluginId: string;
  platform: PlatformName;
}
interface NativeGroup {
  pluginIds: string[];
  platform: PlatformSelection;
  targets?: NativeTarget[];
  command: RecoveryCommand;
  preview: RebuildCommandResult;
}
interface Footprint {
  path: string;
  pluginIds: string[];
  agent: AgentId;
  identity: string;
  sharedNative?: boolean;
  sharedMarketplaceSource?: string;
  nativeGroup?: number;
}
export interface RecoverySourceRefresh {
  sourceId: string;
  candidate: CatalogGenerationCandidateEvidence;
  previousActive: CatalogGenerationActiveV1 | null;
  configDigest: string;
  impact: CatalogSourceImpact;
  impactDigest: string;
}
export interface RecoveryPlan {
  command: RecoveryCommand;
  options: RecoveryOptions & { scope: Scope };
  joint?: JointRecoveryState;
  receipt: RecoveryReceipt;
  dependencyCleanupTargets?: Array<Pick<RecoveryTarget, 'pluginId' | 'agent' | 'scope'>>;
  plannedImpact: { declaration: boolean; preferences: boolean; config: boolean; outputs: boolean };
  changes: string[];
  warnings: string[];
  demand: DemandSnapshot;
  context: ScopeContext;
  originalIntent: string;
  preferencesEvidence: string;
  declaration?: string[];
  preferences?: DeploymentPreferences;
  nativeGroups: NativeGroup[];
  portableGroups: PortablePreparation[];
  portableProtectionGroups: PortablePreparation[];
  preApplyAuthorization?: PreApplyAuthorizationTarget[];
  runtime: RebuildCommandRuntime;
  portableResidues: Array<{ kind: 'cleanup' | 'delivery-switch'; pluginId: string;
    agents: AgentId[]; observation: PortableResidue; retainedTargets?: PortableTarget[] }>;
  sourceRefreshes: RecoverySourceRefresh[];
  sourceRefreshFailures: Array<{ sourceId: string; code: string }>;
  blockExecution: boolean;
}

function isPortableAgent(agent: AgentId): agent is PortableAgent {
  return agent === 'generic';
}

function diagnostic(code: string): RecoveryDiagnostic {
  const messages: Record<string, string> = {
    nativeToolAuthorizationRequired: '原生工具声明有变化，请使用 --yes 或确认当前 Review 后执行。',
    localTargetsRequired: '已有需求，请先设置本机 Agent。',
    deliveryUnsupported: '此插件没有适用于所选 Agent 的交付。',
    operationReviewStale: '确认依据已改变，请重新检查并确认。',
    syncPluginNotDesired: '所选插件尚未声明，请先运行 aw plugin install --only requirements。',
    syncSelectionRequired: '请指定插件或使用 --all。',
    invalidExactTargets: '精确重试目标不属于当前请求，请重新检查并选择。',
    sourceRefreshFailed: '来源刷新失败，此来源的插件未恢复。',
    sourceRefreshConfirmationRequired: '来源更新必须先单独确认，再重新准备插件恢复。',
    artifactCollision: '多个交付占用相同输出位置，请先处理冲突。',
    deliverySwitchCleanupRequired: '此目标仍有旧 Native 输出；请先清理旧交付，再恢复 Portable。',
    deliverySwitchObservationFailed: '无法确认此目标是否仍有旧 Native 输出；请先恢复 Native 观察能力或人工核验。',
    deliverySwitchPortableCleanupRequired: '此目标仍有旧 Portable 输出；请先核验并移开旧交付，再恢复 Native。',
    deliverySwitchPortableObservationFailed: '无法确认此目标是否仍有旧 Portable 输出；请先核验 Portable 现场。',
    'backend-action-unsupported': '此后端尚不支持安全移除，请检查精确的 Portable 输出。',
  };
  return { code, message: messages[code] ?? `操作受阻：${code}。` };
}
export function errorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9-]*$/u.test(code)) return code;
  const prefix = error instanceof Error ? error.message.split(':')[0] : '';
  return /^[A-Za-z][A-Za-z0-9-]*$/u.test(prefix ?? '') ? prefix! : fallback;
}
function intentEvidence(intent: DemandSnapshot['intent']): string {
  return 'rawDigest' in intent ? `${intent.state}:${intent.rawDigest}` : intent.state;
}
function preferenceEvidence(demand: DemandSnapshot): string {
  return 'rawDigest' in demand.preferences
    ? `${demand.preferences.state}:${demand.preferences.rawDigest}` : demand.preferences.state;
}
function agentForPlatform(platform: PlatformName): AgentId {
  return platform;
}
function pair(plan: RecoveryPlan, pluginId: string, agent: AgentId): RecoveryTarget | undefined {
  return plan.receipt.targetResults.find((target) => target.pluginId === pluginId && target.agent === agent);
}
function block(target: RecoveryTarget, code: string, detail = diagnostic(code)): void {
  if (!target.blockers.some((entry) => entry.code === code)) target.blockers.push(detail);
}
function completeReceipt(receipt: RecoveryReceipt): RecoveryReceipt {
  receipt.requestedTargets = receipt.targetResults.map(({ pluginId, agent, scope, delivery }) => ({ pluginId, agent, scope, delivery }));
  receipt.remainingTargets = receipt.targetResults.filter((target) => target.blockers.length > 0
    || !['applied', 'no-op'].includes(target.execution))
    .map(({ pluginId, agent, scope, delivery }) => ({ pluginId, agent, scope, delivery }));
  receipt.ok = receipt.blockers.length === 0 && receipt.remainingTargets.length === 0
    && (receipt.commandResults ?? []).every((result) => result.state === 'completed');
  receipt.errors = [...receipt.blockers];
  receipt.recoveryActions = [...new Set([
    ...(receipt.commandResults ?? []).flatMap((result) => result.recoveryActions),
    ...receipt.blockers.map((entry) => entry.code === 'localTargetsRequired'
      ? `aw target set <target...>` : `aw plugin status --context ${receipt.scope} --json`),
    ...receipt.remainingTargets.flatMap((target) => {
      const result = receipt.targetResults.find((entry) => entry.pluginId === target.pluginId && entry.agent === target.agent);
      if (result?.recoveryActions?.length) return result.recoveryActions;
      return result?.blockers.some((entry) => entry.code === 'backend-action-unsupported' || entry.code === 'portableObservationFailed')
        ? `检查 ${target.pluginId} 的 Portable 输出及 provider 关联；AW 不支持安全自动删除。`
        : `aw plugin sync ${target.pluginId} --context ${receipt.scope} --target ${target.agent}`;
    }),
  ])];
  return receipt;
}

function displayPortablePath(plan: RecoveryPlan, physicalPath: string): string {
  if (plan.options.scope === 'user' || !plan.context.projectRoot) return physicalPath;
  const relative = path.relative(plan.context.projectRoot, physicalPath);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? `项目根目录/${relative.split(path.sep).join('/')}` : physicalPath;
}

function portableRecoveryActions(plan: RecoveryPlan, pluginId: string,
  targets: readonly (PortableTarget | PortableResidue['targets'][number])[]): string[] {
  return [...new Set(targets.map((target) => {
    const directory = displayPortablePath(plan, target.physicalPath);
    const shared = target.agent === 'generic' || target.agent === 'antigravity'
      ? '该目录可能同时被 Codex 和 Cursor 读取；移开前请确认对两者的影响。' : `该目录供 ${target.agent} 使用。`;
    return `${pluginId}：请检查并备份目录 ${directory}；确认归属后可自行移开。${shared}`
      + (plan.command === 'cleanup' || plan.command === 'uninstall'
        ? '无法证实该目录的安全删除边界；处理后重新检查状态。'
        : `然后重试 aw plugin sync ${pluginId} --context ${plan.options.scope} --target ${target.agent}。`);
  }))];
}

function selectRoots(demand: DemandSnapshot, selectors: readonly string[], all: boolean): string[] {
  const roots = demand.roots?.map((root) => root.pluginId) ?? [];
  if (all && selectors.length) throw new Error('syncSelectorConflict');
  if (all) return roots;
  if (!selectors.length) return roots;
  return [...new Set(selectors.map((selector) => {
    const parsed = parsePluginId(selector);
    const matches = roots.filter((id) => parsed.sourceId ? id === selector
      : parsePluginId(id).pluginName === parsed.pluginName);
    if (matches.length !== 1) throw new Error('syncPluginNotDesired');
    return matches[0]!;
  }))];
}

function nativeGroupTargets(group: Pick<NativeGroup, 'pluginIds' | 'platform' | 'targets'>): NativeTarget[] {
  return group.targets ?? group.pluginIds.flatMap((pluginId) =>
    (group.platform === 'both' ? ['codex', 'claude'] as const : [group.platform])
      .map((platform) => ({ pluginId, platform })));
}

function nativeTargetSelection(targets: readonly NativeTarget[]): {
  pluginIds: string[]; platform: PlatformSelection; targets: NativeTarget[];
} {
  const platforms = new Set(targets.map((target) => target.platform));
  return { pluginIds: [...new Set(targets.map((target) => target.pluginId))],
    platform: platforms.size === 1 ? targets[0]!.platform : 'both', targets: [...targets] };
}

// Rebuild accumulates one marketplace generation per platform across sources and scopes.
async function readNativeGroups<G extends { platform: PlatformSelection; command: RecoveryCommand }, T>(
  groups: readonly G[], read: (group: G) => Promise<T>, signal?: AbortSignal,
): Promise<T[]> {
  const lanes = new Map<string, G[]>();
  for (const group of groups) {
    const key = group.command === 'install' || group.command === 'sync' ? group.platform : 'serial';
    const lane = lanes.get(key) ?? [];
    lane.push(group);
    lanes.set(key, lane);
  }
  const results = new Map<G, T>();
  await mapInstallReads([...lanes.values()], async (lane) => {
    for (const group of lane) {
      signal?.throwIfAborted();
      results.set(group, await read(group));
    }
  }, { signal });
  return groups.map((group) => results.get(group)!);
}

async function nativeOperation(plan: RecoveryPlan, pluginIds: string[], platform: PlatformSelection,
  preview: boolean, runtime: RebuildCommandRuntime = plan.runtime,
  command: RecoveryCommand = plan.command, selectedTargets?: readonly NativeTarget[],
  catalogReadScope?: CatalogPreparationReadScope): Promise<RebuildCommandResult> {
  if (!runtime.awHomeMutationToken) {
    await prepareNativeCliExecution({ env: plan.context.env, runner: runtime.nativeCliRunner });
  }
  const rebuildCommand = command === 'install' ? 'sync' : command;
  const requirements = command === 'cleanup' && (plan.demand.intent.state !== 'valid'
    || plan.demand.preferences.state === 'invalid' || plan.demand.preferences.state === 'unreadable')
    ? createEmptyNativeDemandView() : demandNativeProjection(plan.demand);
  if (plan.options.sharedReferenceView) requirements.sharedReferenceView = plan.options.sharedReferenceView;
  const result = await runRebuildCommand({
    command: rebuildCommand,
    pluginNames: pluginIds,
    commandOptions: {
      cwd: plan.context.executionCwd, scope: plan.options.scope, platform,
      yes: plan.options.yes,
      scriptTimeoutMs: plan.options.scriptTimeoutMs,
      ...(plan.options.dependencyScopeOverrides ? { dependencyScopeOverrides: plan.options.dependencyScopeOverrides } : {}),
      ...(command === 'cleanup' || command === 'uninstall' ? { force: plan.options.force } : {}),
    },
    runtime: {
      ...runtime,
      preserveLegacyNativeSkills: plan.options.existingOnly === true,
      nativeActivationOnlyTargets: plan.options.nativeActivationOnlyTargets,
      nativePlannedRetirements: plan.options.nativePlannedRetirements,
      ...(preview ? { nativeCliRunner: bindNativeCliRunnerSignal(
        runtime.nativeCliRunner ?? getDefaultNativeCliRunner(), runtime.signal) } : {}),
      env: plan.options.env,
      catalogOperationContext: plan.demand.catalogOperationContext,
      catalogReadScope,
      previewOperationPlan: preview,
      executionInput: {
        context: plan.context,
        requirements,
        selectedTargets: (selectedTargets ?? nativeGroupTargets({ pluginIds, platform }))
          .map((target) => ({ ...target, scope: plan.options.scope })),
        preserveOtherObservedTargets: true,
      },
    },
  });
  if (preview) runtime.signal?.throwIfAborted();
  return result;
}

function nativeResults(plan: RecoveryPlan, group: NativeGroup,
  result: RebuildCommandResult, executed: boolean): void {
  for (const diagnostic of result.recoveryDiagnostics ?? []) {
    if (!plan.receipt.blockers.some((entry) => JSON.stringify(entry) === JSON.stringify(diagnostic))) plan.receipt.blockers.push(diagnostic);
  }
  if (executed && result.commandResults?.length) {
    plan.receipt.commandResults = [...new Map([
      ...(plan.receipt.commandResults ?? []), ...result.commandResults,
    ].map((entry) => [getCommandPackageId(entry.producer), entry])).values()];
  }
  const backend = buildRebuildReceiptJson(group.command === 'install' ? 'sync' : group.command, result);
  for (const { pluginId, platform } of nativeGroupTargets(group)) {
    const agent = agentForPlatform(platform);
    const target = pair(plan, pluginId, agent)!;
    if (!target) continue;
    target.backend = backend;
    const matchesTarget = (entry: ReceiptTargetResult) => entry.target.pluginId === pluginId
      && entry.target.platform === platform && entry.target.scope === plan.options.scope;
    const backendTargets = result.targetResults.filter(matchesTarget);
    const deploymentPlans = new Map([
      ...(group.preview.operationPlan?.deploymentPlans ?? []),
      ...(result.operationPlan?.deploymentPlans ?? []),
    ].filter((deployment) => deployment.binding.plugin.pluginId === pluginId
      && deployment.binding.platform === platform && deployment.binding.scope.kind === plan.options.scope)
      .map((deployment) => [deployment.binding.id, deployment]));
    if (deploymentPlans.size) target.deploymentPlans = [...deploymentPlans.values()];
    const exclusions = [
      ...(group.preview.deploymentExclusions ?? []),
      ...(result.deploymentExclusions ?? []),
      ...(group.preview.operationPlan?.deploymentExclusions ?? []),
      ...(result.operationPlan?.deploymentExclusions ?? []),
      ...result.rebuildResults.flatMap((entry) => entry.deploymentExclusions ?? []),
    ].filter((entry) => entry.pluginId === pluginId && entry.platform === platform && entry.scope.kind === plan.options.scope);
    if (exclusions.length) target.deploymentExclusions = [...new Map(exclusions.map((entry) =>
      [JSON.stringify([entry.pluginId, entry.platform, entry.scope, entry.productId, entry.reasonCode]), entry])).values()];
    const dependencies = result.dependencyPlan?.targets.filter((entry) =>
      entry.platform === platform && (entry.pluginId === pluginId || entry.requiredBy?.includes(pluginId))) ?? [];
    const producers = (result.commandResults ?? []).filter((entry) => {
      if (entry.producer.platform !== null && entry.producer.platform !== platform) return false;
      if (entry.producer.platform === null) {
        // Package identity is shared by AW; its declaration defines the Native consumers.
        const plugin = plan.demand.plugins.find((plugin) => plugin.sourceId === entry.producer.sourceId
          && plugin.sourceIdentity === entry.producer.sourceIdentity
          && plugin.manifest.name === entry.producer.pluginName);
        const declaration = plugin?.manifest.managedCommands?.packages.find((declaration) =>
          declaration.key === entry.producer.key && declaration.scope === entry.producer.scope);
        if (!declaration?.platforms.includes(platform)
          || entry.producer.scope === 'project' && entry.producer.projectRoot !== plan.context.projectRoot) return false;
      }
      const producerPluginId = `${entry.producer.sourceId}/${entry.producer.pluginName}`;
      return producerPluginId === pluginId
        || dependencies.some((dependency) => dependency.pluginId === producerPluginId)
        || result.targetResults.some((target) => target.target.pluginId === producerPluginId
          && target.target.platform === platform && target.requiredBy?.includes(pluginId)
          && target.target.scope === (result.dependencyPlan?.targets.find((dependency) =>
            dependency.pluginId === producerPluginId && dependency.platform === platform)?.resolvedScope
            ?? plan.options.scope));
    });
    target.recoveryActions = backend.targetResults.length || backend.commandResults?.length
      ? [...new Set([
        ...backend.targetResults.filter(matchesTarget).flatMap((entry) => entry.recoveryActions),
        ...producers.flatMap((producer) => producer.recoveryActions),
      ])]
      : backend.recoveryActions;
    for (const failure of backendTargets.filter((entry) => entry.state === 'failed')) {
      block(target, failure.errorCode ?? 'nativeRecoveryFailed');
    }
    // Keep checked recovery locations even when preparation stops before execution.
    const nativeDiagnostics = result.rebuildResults.filter((entry) => entry.target.pluginId === pluginId
      && entry.target.platform === platform && entry.target.scope === plan.options.scope)
      .flatMap((entry) => entry.deploymentReceipts ?? [])
      .flatMap((entry) => [...entry.diagnostics, ...entry.effects.flatMap((effect) => effect.diagnostics)])
      .filter((entry) => entry.detail);
    for (const entry of nativeDiagnostics) {
      const destination = entry.severity === 'error' ? target.blockers : (target.reasons ??= []);
      const detail: RecoveryDiagnostic = { code: entry.code, message: entry.message, subject: entry.subject, detail: entry.detail };
      if (!destination.some((previous) => JSON.stringify(previous) === JSON.stringify(detail))) destination.push(detail);
    }
    for (const dependency of dependencies.filter((entry) => entry.action === 'block')) {
      block(target, dependency.errorCode ?? 'dependencyNotReady');
    }
    for (const dependency of dependencies.filter((entry) => entry.pluginId !== pluginId)) {
      for (const failure of result.targetResults.filter((entry) => entry.target.pluginId === dependency.pluginId
        && entry.target.platform === dependency.platform && entry.target.scope === dependency.resolvedScope && entry.state === 'failed')) {
        const code = failure.errorCode ?? 'dependencyNotReady';
        block(target, code, { ...diagnostic(code), pluginId: dependency.pluginId });
      }
    }
    if (executed) {
      const deployments = result.rebuildResults.filter((entry) => entry.target.pluginId === pluginId
        && entry.target.platform === platform && entry.target.scope === plan.options.scope)
        .flatMap((entry) => entry.deploymentReceipts ?? []);
      if (deployments.length) target.deploymentReceipts = deployments.map((entry) => ({ ...entry,
        products: deploymentPlans.get(entry.bindingId)?.binding.consumers ?? [],
      }));
      const commandFailures = producers.filter((entry) => entry.state !== 'completed');
      for (const producer of commandFailures) {
        for (const error of producer.errors) block(target, error.code);
        if (producer.errors.length === 0) block(target, 'managedCommandRecoveryFailed');
      }
      const succeeded = commandFailures.length === 0 && backendTargets.length > 0
        && backendTargets.every((entry) => entry.state === 'completed');
      const effects = deployments.flatMap((entry) => entry.effects);
      const changed = effects.some((effect) => effect.mutation !== 'none');
      if (succeeded) {
        const unchanged = deployments.length > 0 ? effects.every((effect) => effect.status === 'unchanged')
          : backendTargets.every((entry) => entry.action === 'skipped');
        target.execution = unchanged ? 'no-op' : 'applied';
      } else {
        const blockedByDependency = !changed && backendTargets.length > 0
          && backendTargets.every((entry) => entry.errorCode === 'dependencyInstallFailed')
          && result.rebuildResults.filter((entry) => entry.target.pluginId === pluginId && entry.target.platform === platform
            && entry.target.scope === plan.options.scope).every((entry) => !entry.cleanupAttempted && entry.actions.length === 0);
        target.execution = blockedByDependency ? 'not-run'
          : changed || backendTargets.some((entry) => entry.state === 'completed') ? 'partial' : 'failed';
      }
      plan.receipt.outputsMayHaveChanged ||= changed;
      if (succeeded && (plan.command === 'cleanup' || plan.command === 'uninstall')) {
        const completed = result.rebuildResults.filter((entry) => entry.target.pluginId === pluginId
          && entry.target.platform === platform && entry.target.scope === plan.options.scope);
        const footprints = result.nativeFootprints?.filter((entry) => entry.pluginId === pluginId
          && entry.platform === platform && entry.scope === plan.options.scope);
        const absent = completed.length > 0 && footprints !== undefined && footprints.length > 0
          && footprints.every((entry) => !entry.shared)
          && completed.every((entry) => entry.status === 'succeeded' && entry.cleanupAttempted
            && entry.removed.length + entry.absent.length > 0 && entry.residual.length === 0
            && entry.quarantined.length === 0 && entry.failures.length === 0);
        target.observation = absent ? 'missing' : 'unknown';
        target.content = absent ? 'absent' : 'unknown';
      } else {
        target.observation = succeeded ? 'verified' : 'unknown';
        target.content = succeeded ? 'satisfied' : 'unknown';
      }
      if (!succeeded && !target.blockers.length) block(target, 'nativeRecoveryFailed');
    }
  }
}

/** All scopes share one final marketplace generation before Review is returned. */
export async function refreshRecoveryNativePreviews(plan: RecoveryPlan, catalogReadScope?: CatalogPreparationReadScope,
  signal: AbortSignal | undefined = plan.runtime.signal): Promise<void> {
  const previews = await readNativeGroups(plan.nativeGroups, (group) =>
    nativeOperation(plan, group.pluginIds, group.platform, true,
      { ...plan.runtime, signal }, group.command, nativeGroupTargets(group), catalogReadScope), signal);
  for (const [index, group] of plan.nativeGroups.entries()) {
    group.preview = previews[index]!;
    nativeResults(plan, group, group.preview, false);
  }
  completeReceipt(plan.receipt);
}

function portableRequiredBy(plan: RecoveryPlan, prepared: PortablePreparation,
  target: PortableTarget): string[] {
  return plan.portableGroups.filter((group) => group.logicalIdentity === prepared.logicalIdentity
    && group.targets.some((entry) => entry.providerPluginId === target.providerPluginId
      && entry.expectedDigest === target.expectedDigest && entry.physicalPath === target.physicalPath))
    .map((group) => group.options.selector);
}

function portableResults(plan: RecoveryPlan, prepared: PortablePreparation): void {
  for (const agent of prepared.options.agents) {
    const target = pair(plan, prepared.options.selector, agent)!;
    const observations = prepared.targets.filter((entry) => entry.agent === agent);
    const gaps = (prepared.unmet ?? []).filter((gap) => gap.agent === agent);
    if (gaps.length) target.componentGaps = gaps;
    target.content = observations.some((entry) => entry.observation === 'conflict') ? 'conflict'
      : observations.some((entry) => entry.observation === 'unknown') ? 'unknown'
      : observations.some((entry) => entry.observation === 'drifted') ? 'drifted'
      : observations.some((entry) => entry.observation === 'absent') ? 'absent'
      : observations.length || prepared.intentionalEmpty && gaps.length === 0 ? 'satisfied' : 'unknown';
    if (gaps.length && target.content !== 'conflict') target.content = 'unknown';
    target.observation = target.content === 'satisfied' ? 'verified'
      : target.content === 'absent' ? 'missing' : 'unknown';
    for (const gap of gaps) plan.changes.push(`组件未满足 · ${gap.providerPluginId} · ${gap.componentId ?? gap.id} · ${gap.reasonCode}`
      + gap.requiredFeatures.map((requirement) => ` · ${requirement.feature}${requirement.values ? `: ${requirement.values.join(', ')}` : ''}`).join(''));
    for (const code of [...prepared.globalBlockers, ...observations.flatMap((entry) => entry.blocker
      && !(entry.disposition === 'retain' && entry.blocker === 'portableComponentsUnmet') ? [entry.blocker] : [])]) {
      block(target, code, portablePreparationDiagnostic(prepared, diagnostic(code), agent));
    }
    target.backend = observations.map((entry) => ({ skill: entry.skill, providerPluginId: entry.providerPluginId,
      requiredBy: portableRequiredBy(plan, prepared, entry), observation: entry.observation,
      ownership: entry.ownership, associatedAgents: entry.associatedAgents }));
    target.recoveryActions = portableRecoveryActions(plan, target.pluginId,
      observations.filter((entry) => ['conflict', 'unknown'].includes(entry.observation)));
  }
}

function portableOutcomes(plan: RecoveryPlan, prepared: PortablePreparation,
  agent: AgentId, outcomes: PortableExecutionTarget[], globalBlockers: string[]): void {
  const target = pair(plan, prepared.options.selector, agent)!;
  const contentOutcomes = outcomes.filter((entry) => entry.disposition !== 'remove');
  const preparedTargets = prepared.targets.filter((entry) => entry.agent === agent);
  const gaps = (prepared.unmet ?? []).filter((gap) => gap.agent === agent);
  if (gaps.length) target.componentGaps = gaps;
  const intentionalEmpty = prepared.mode === 'deploy' && prepared.intentionalEmpty && gaps.length === 0 && prepared.blockers.length === 0
    && globalBlockers.length === 0 && preparedTargets.every((entry) => entry.disposition === 'remove')
    && outcomes.length === preparedTargets.length
    && outcomes.every((entry) => entry.observation === 'absent' && entry.blockers.length === 0
      && ['applied', 'no-op'].includes(entry.execution));
  target.execution = (prepared.mode === 'cleanup' || intentionalEmpty) && outcomes.length === 0 && !globalBlockers.length ? 'no-op' : outcomes.length > 0 && outcomes.every((entry) => entry.execution === 'no-op') ? 'no-op'
    : outcomes.length > 0 && outcomes.every((entry) => ['applied', 'no-op'].includes(entry.execution)) ? 'applied'
    : outcomes.some((entry) => ['applied', 'no-op'].includes(entry.execution)) ? 'partial'
    : outcomes.some((entry) => entry.execution === 'failed') ? 'failed' : 'not-run';
  target.observation = contentOutcomes.length > 0 && contentOutcomes.every((entry) => entry.observation === 'satisfied')
    && globalBlockers.length === 0 ? 'verified'
    : globalBlockers.length === 0 && contentOutcomes.some((entry) => entry.observation === 'absent'
      || entry.observation === 'drifted') && contentOutcomes.every((entry) => entry.observation !== 'unknown'
      && entry.observation !== 'conflict') ? 'missing' : 'unknown';
  target.content = contentOutcomes.some((entry) => entry.observation === 'conflict') ? 'conflict'
    : contentOutcomes.some((entry) => entry.observation === 'unknown') ? 'unknown'
    : contentOutcomes.some((entry) => entry.observation === 'drifted') ? 'drifted'
    : contentOutcomes.some((entry) => entry.observation === 'absent') ? 'absent'
    : contentOutcomes.length ? 'satisfied' : 'unknown';
  if (prepared.mode === 'cleanup' && globalBlockers.length === 0
    && outcomes.every((entry) => entry.observation === 'absent' && entry.blockers.length === 0)) {
    target.observation = 'missing'; target.content = 'absent';
  } else if (intentionalEmpty) {
    target.observation = 'verified'; target.content = 'satisfied';
  }
  if (gaps.length) {
    if (target.execution === 'applied' || target.execution === 'no-op') target.execution = 'partial';
    if (target.content !== 'conflict') target.content = 'unknown';
    target.observation = 'unknown';
    block(target, 'portableComponentsUnmet');
  }
  target.backend = outcomes.map((entry) => ({ skill: entry.skill, providerPluginId: entry.providerPluginId,
    requiredBy: portableRequiredBy(plan, prepared, entry), observation: entry.observation,
    ownership: entry.ownership, associatedAgents: entry.associatedAgents,
    execution: entry.execution, blockers: entry.blockers }));
  for (const code of [...globalBlockers, ...outcomes.flatMap((entry) => entry.blockers)]) block(target, code);
  target.recoveryActions = portableRecoveryActions(plan, target.pluginId, outcomes.filter((entry) =>
    entry.observation === 'conflict' || entry.observation === 'unknown' && !entry.blockers.includes('operationReviewStale')));
  if (globalBlockers.includes('operationReviewStale') && prepared.mode !== 'cleanup') {
    target.recoveryActions.push(`aw plugin sync ${target.pluginId} --context ${target.scope} --target ${agent}`);
  }
}

function portablePluginClosure(plan: RecoveryPlan, prepared: PortablePreparation) {
  const { sourceId, pluginName } = parsePluginId(prepared.options.selector);
  return resolvePluginMetaDependencyClosure(plan.demand.plugins.filter((plugin) => plugin.sourceId === sourceId), [pluginName!])
    .filter((plugin) => !prepared.options.excludedPluginIds?.includes(plugin.pluginId!));
}

export function verifiedInheritedPortableProviders(plan: RecoveryPlan): PortablePreparation[] {
  const ids = plan.options.inheritedPortableProviderIds;
  if (!ids?.length) return [];
  return plan.portableGroups.filter((group) => ids.includes(group.options.selector) && !group.blockers.length
    && !group.unmet.length && group.targets.some((target) => target.providerPluginId === group.options.selector)
    && group.targets.every((target) => target.disposition === 'write' && target.ownership === 'aw'
      && target.observation === 'satisfied' && target.installedDigest === target.expectedDigest));
}

function preparePortablePreApplyAuthorization(plan: RecoveryPlan): void {
  if (plan.command === 'cleanup' || plan.command === 'uninstall') return;
  const authorization = new Map<string, PreApplyAuthorizationTarget>();
  const verifiedProviders = new Set(verifiedInheritedPortableProviders(plan).map((group) => group.options.selector));
  for (const prepared of plan.portableGroups) {
    for (const plugin of portablePluginClosure(plan, prepared)) {
      if (!plugin.manifest.scripts?.preApply || verifiedProviders.has(plugin.pluginId!)) continue;
      for (const platform of prepared.options.agents) {
        if (pair(plan, prepared.options.selector, platform)?.blockers.length) continue;
        const target: PreApplyAuthorizationTarget = {
          pluginId: plugin.pluginId!, pluginName: plugin.manifest.name,
          sourceId: plugin.sourceId!, sourceIdentity: plugin.sourceIdentity!,
          platform, scope: plan.options.scope,
          relation: plugin.pluginId === prepared.options.selector ? 'requested'
            : plan.demand.plugins.find((entry) => entry.pluginId === prepared.options.selector)?.manifest.dependencies?.includes(plugin.manifest.name)
              ? 'direct' : 'transitive',
        };
        authorization.set([target.pluginId, target.platform, target.scope].join('\0'), target);
      }
    }
  }
  plan.preApplyAuthorization = [...authorization.values()];
  plan.changes.push(...plan.preApplyAuthorization.map((target) =>
    `运行插件 preApply 脚本：${target.pluginId} / ${target.platform} / ${target.scope}。`));
}

async function executePortablePreApply(plan: RecoveryPlan, prepared: PortablePreparation,
  agent: PortableAgent, runtime: RebuildCommandRuntime): Promise<string | undefined> {
  if (prepared.mode === 'cleanup' || plan.command === 'cleanup' || plan.command === 'uninstall') return;
  const plugins = portablePluginClosure(plan, prepared);
  const required = plan.preApplyAuthorization?.filter((target) => target.platform === agent
    && plugins.some((plugin) => plugin.pluginId === target.pluginId)) ?? [];
  return executePreApplyAuthorization(plan, required, runtime);
}

async function executePreApplyAuthorization(plan: RecoveryPlan, required: readonly PreApplyAuthorizationTarget[],
  runtime: RebuildCommandRuntime): Promise<string | undefined> {
  if (!required.length) return;
  if (plan.options.yes !== true && runtime.preApplyConfirmed !== true) return 'preApplyAuthorizationRequired';
  const cache = runtime.preApplyExecutionCache ??= new Map<string, Promise<void>>();
  for (const target of required) {
    runtime.signal?.throwIfAborted();
    const plugin = plan.demand.plugins.find((entry) => entry.pluginId === target.pluginId);
    if (!plugin || plugin.sourceIdentity !== target.sourceIdentity) return 'sourceUnavailable';
    const context = target.scope === plan.options.scope ? plan.context
      : await createScopeContext({ scope: target.scope, cwd: plan.context.callerCwd, env: plan.options.env });
    try {
      const projectKey = target.scope !== 'project' ? '' : target.platform === 'codex'
        ? await resolveCodexProjectKey(context.executionCwd) : target.platform === 'claude'
          ? await resolveClaudeProjectKey(context.executionCwd) : context.projectKey;
      const key = [target.sourceIdentity, target.pluginId, target.platform, target.scope, projectKey].join('\0');
      let execution = cache.get(key);
      if (!execution) {
        execution = runPreApplyScript({ plugin, platform: target.platform, scope: target.scope,
          cwd: context.executionCwd, context: { env: context.env, interruption: runtime.interruption },
          referencePlugins: plan.demand.plugins, scriptTimeoutMs: plan.options.scriptTimeoutMs });
        cache.set(key, execution);
      }
      await execution;
    }
    catch (error) {
      const interrupted = recoveryInterruptionCode(error, runtime.signal);
      if (interrupted) {
        const affected = pair(plan, target.pluginId, target.platform);
        if (affected) {
          affected.execution = 'partial'; affected.observation = 'unknown'; affected.content = 'unknown';
          block(affected, interrupted);
        }
        plan.receipt.outputsMayHaveChanged = true;
        throw error;
      }
      const operationDiagnostic = readSafeOperationError(error);
      const affected = pair(plan, target.pluginId, target.platform);
      if (affected) {
        affected.execution = 'failed';
        block(affected, 'preApplyFailed');
        if (affected.delivery?.kind === 'native') {
          const identity = { pluginId: target.pluginId, pluginName: plugin.manifest.name, pluginVersion: plugin.manifest.version,
            sourceId: plugin.sourceId, sourceIdentity: target.sourceIdentity, platform: affected.delivery.platform,
            scope: target.scope, cwd: context.executionCwd };
          const failure = { phase: 'preApply' as const, message: operationDiagnostic?.safeMessage ?? 'The preApply script failed.',
            ...(operationDiagnostic ? { operationDiagnostic } : {}) };
          affected.backend = buildRebuildReceiptJson(plan.command, { platforms: [target.platform], plugins: [], warnings: [],
            targetResults: [{ target: identity, action: 'install', state: 'failed', errorCode: 'preApplyFailed' }],
            rebuildResults: [{ status: 'failed', command: plan.command, target: identity, actions: [{ name: 'preApply', status: 'failed' }],
              cleanupAttempted: false, removed: [], absent: [], residual: [], quarantined: [], failures: [failure], error: failure }] });
        }
      }
      return 'preApplyFailed';
    } finally { if (context !== plan.context) await context.dispose(); }
  }
}

/** Run the reviewed replacement's hooks before any dependent old-output cleanup. */
export async function executeRecoveryPreApply(plan: RecoveryPlan, pluginId: string, agent: AgentId,
  runtime: RebuildCommandRuntime): Promise<string | undefined> {
  if (plan.command === 'cleanup' || plan.command === 'uninstall') return;
  if (plan.receipt.nativeToolChanges?.length && plan.options.yes !== true) return 'nativeToolAuthorizationRequired';
  const target = pair(plan, pluginId, agent);
  if (!target) return 'preApplyTargetUnavailable';
  if (target.blockers.length) return target.blockers[0]!.code;
  if (target.delivery?.kind === 'native') {
    const platform = target.delivery.platform;
    try {
      const authorization = await nativeOperation(plan, [pluginId], platform, true,
        { ...runtime, resolvePreApplyAuthorization: true }, plan.command, [{ pluginId, platform }]);
      if (authorization.overallState !== 'succeeded' || !authorization.preApplyAuthorization) {
        return authorization.targetResults.find((result) => result.errorCode)?.errorCode ?? 'preApplyAuthorizationUnavailable';
      }
      const blocked = authorization.dependencyPlan?.targets.find((entry) => entry.action === 'block'
        && (entry.pluginId === pluginId || entry.requiredBy.includes(pluginId)));
      if (blocked) return blocked.errorCode ?? 'nativePreparationFailed';
      return executePreApplyAuthorization(plan, authorization.preApplyAuthorization, runtime);
    } catch (error) {
      if (recoveryInterruptionCode(error, runtime.signal)) throw error;
      return readSafeOperationError(error)?.code ?? errorCode(error, 'nativePreparationFailed');
    }
  }
  if (isPortableAgent(agent)) {
    const prepared = plan.portableGroups.find((group) => group.options.selector === pluginId
      && group.options.agents.includes(agent));
    if (prepared) return executePortablePreApply(plan, prepared, agent, runtime);
  }
}

export async function checkFootprints(plan: RecoveryPlan): Promise<void> {
  const footprints: Footprint[] = [];
  for (const [nativeGroup, group] of plan.nativeGroups.entries()) {
    const actions = group.preview.operationPlan?.actions.filter((action) =>
      (action.kind === 'writeOwnedArtifact' || action.kind === 'removeOwnedArtifact')
      && !group.preview.nativeFootprints?.some((footprint) => footprint.path === action.path
        && footprint.pluginId === action.pluginId && footprint.platform === action.platform)) ?? [];
    for (const action of [...(group.preview.nativeFootprints ?? []), ...actions]) {
      if (!('path' in action)) continue;
      const consumers = group.preview.dependencyPlan?.targets.filter((target) => target.pluginId === action.pluginId)
        .flatMap((target) => target.requiredBy ?? []) ?? [];
      footprints.push({ path: action.path,
        pluginIds: group.pluginIds.filter((id) => id === action.pluginId || consumers.includes(id)),
        agent: agentForPlatform(action.platform), identity: `native:${action.platform}:${action.pluginId}`,
        sharedNative: 'shared' in action && action.shared,
        ...('sharedMarketplace' in action && action.sharedMarketplace
          ? { sharedMarketplaceSource: parsePluginId(action.pluginId).sourceId } : {}),
        nativeGroup });
    }
  }
  for (const prepared of plan.portableGroups) {
    for (const target of prepared.targets) footprints.push({
      path: target.physicalPath,
      pluginIds: [prepared.options.selector], agent: target.agent,
      identity: JSON.stringify(['agent-skills', prepared.logicalIdentity, target.providerPluginId, target.expectedDigest,
        target.configDigest, target.disposition]),
    });
  }
  const paths = [...new Set(footprints.map((entry) => entry.path))];
  const canonical = new Map(await mapInstallReads(paths, async (value) =>
    [value, await canonicalizePathThroughExistingAncestor(value)] as const, { signal: plan.runtime.signal }));
  for (const item of footprints) item.path = canonical.get(item.path)!;
  for (let index = 0; index < footprints.length; index += 1) {
    const left = footprints[index]!;
    for (const right of footprints.slice(index + 1)) {
      const overlap = left.path === right.path || left.path.startsWith(right.path + path.sep) || right.path.startsWith(left.path + path.sep);
      if (!overlap || left.identity === right.identity
        || (left.nativeGroup !== undefined && left.nativeGroup === right.nativeGroup)
        || (left.sharedMarketplaceSource !== undefined && left.agent === right.agent
          && left.sharedMarketplaceSource === right.sharedMarketplaceSource)
        || (left.sharedNative && right.sharedNative && left.agent === right.agent)) continue;
      for (const footprint of [left, right]) {
        for (const pluginId of footprint.pluginIds) {
          const target = pair(plan, pluginId, footprint.agent);
          if (target) block(target, 'artifactCollision');
        }
      }
    }
  }
  for (const prepared of plan.portableGroups) {
    const layout = portableRecoveryLayout(plan.context);
    plan.changes.push(`${prepared.options.selector}：AW 写入所选 Agent 的 owned Skill 目录；准备目录 ${layout.generationRoot}。`);
  }
}

export async function prepareScopedRecovery(command: RecoveryCommand, selectors: readonly string[],
  options: RecoveryOptions & { scope: Scope }, runtime: RebuildCommandRuntime = {},
  { catalogReadScope, nativeObservationBatch, portableGenerations = new Map() }: RecoveryPreparationReads = {}): Promise<RecoveryPlan> {
  runtime = { ...runtime, preparedArtifactRenderResults: runtime.preparedArtifactRenderResults ?? new Map() };
  options.signal?.throwIfAborted();
  const context = await createScopeContext({ scope: options.scope, cwd: options.cwd, env: options.env });
  try {
  options.signal?.throwIfAborted();
  options = { ...options, cwd: context.executionCwd, env: context.env };
  let demand = options.demandOverride ?? await readDemand({ ...options, preferences: undefined });
  const refreshFailures = new Map<string, string>();
  const sourceRefreshes: RecoverySourceRefresh[] = [];
  if (options.refresh && command === 'sync') {
    let selected: string[] = [];
    try { selected = selectRoots(demand, selectors, options.all ?? false); }
    catch { /* Selection below reports the invalid request without refreshing any source. */ }
    if (selected.length > 0) {
      const config = await readCatalogSourcesConfigSnapshot(options.env);
      const generationState = await readCatalogGenerationState(options.env);
      for (const sourceId of new Set(selected.map((id) => parsePluginId(id).sourceId!))) {
        try {
          const source = config.config.sources.find((entry) => entry.id === sourceId);
          const probe = await probeCatalogSourceGeneration({ sourceId, env: options.env,
            cliVersion: options.cliVersion, signal: options.signal, runtime: runtime.catalogGenerationRuntime });
          const previousActive = generationState.sources[sourceId]?.active ?? null;
          const candidateChanged = !previousActive
            || previousActive.sourceConfigFingerprint !== probe.candidate.sourceConfigFingerprint
            || previousActive.sourceIdentity !== probe.candidate.sourceIdentity
            || previousActive.logicalIdentity !== probe.candidate.logicalIdentity
            || previousActive.requestedRef !== probe.candidate.requestedRef
            || previousActive.manifestDigest !== probe.candidate.manifestDigest
            || previousActive.snapshotDigest !== probe.candidate.snapshotDigest
            || previousActive.resolvedCommit !== probe.candidate.resolvedCommit;
          if (!candidateChanged) continue;
          const inspectImpact = runtime.catalogGenerationRuntime?.inspectSourceImpact
            ?? inspectCatalogSourceImpact;
          const impact = await inspectImpact({ sourceId, cwd: options.cwd, env: options.env,
            sourcePrimary: source?.primary === true, mode: 'generation', candidateManifest: probe.manifest });
          sourceRefreshes.push({ sourceId, candidate: probe.candidate, previousActive,
            configDigest: config.digest, impact, impactDigest: calculateCatalogSourceImpactDigest(impact) });
        }
        catch (error) {
          if (recoveryInterruptionCode(error, options.signal)) throw error;
          const code = errorCode(error, 'catalogGenerationRefreshFailed');
          refreshFailures.set(sourceId, code.startsWith('catalog') ? code : 'catalogGenerationRefreshFailed');
        }
      }
    }
  }
  options.signal?.throwIfAborted();
  const originalIntent = intentEvidence(demand.intent);
  const proposed = command === 'install'
    ? await addRequirements({ ...options, selectors, dryRun: true, installSelectors: true }) : undefined;
  if (proposed?.state && proposed.errors.length === 0) {
    const rawBytes = Buffer.from(JSON.stringify(proposed.state));
    demand = await readDemand({ ...options, preferences: undefined, intent: {
      state: 'valid', value: proposed.state, rawBytes,
      digest: calculateIntentDigest(proposed.state), rawDigest: originalIntent,
    } });
  }
  const receipt: RecoveryReceipt = {
    schemaVersion: 1, kind: 'aw-recovery', scope: options.scope, command, ok: false,
    intent: { state: demand.intent.state, ...('digest' in demand.intent ? { digest: demand.intent.digest } : {}),
      roots: demand.roots?.map((root) => root.pluginId) ?? null },
    requestedRoots: [], requestedTargets: [], selection: { agents: [], origin: 'none', preferences: demand.preferences.state },
    blockers: proposed?.errors ?? [], errors: [], targetResults: [], remainingTargets: [], recoveryActions: [],
    declarationChanged: false, preferencesChanged: false, configChanged: false, outputsMayHaveChanged: false,
  };
  const { signal: _signal, ...executionOptions } = options;
  const plan: RecoveryPlan = { command, options: executionOptions, receipt, demand, context, originalIntent,
    plannedImpact: { declaration: proposed?.changed === true, preferences: false, config: false, outputs: false },
    preferencesEvidence: preferenceEvidence(demand), changes: [], warnings: [],
    nativeGroups: [], portableGroups: [],
    portableProtectionGroups: [], runtime,
    portableResidues: [], sourceRefreshes,
    sourceRefreshFailures: [...refreshFailures].map(([sourceId, code]) => ({ sourceId, code })),
    blockExecution: false,
    ...(proposed?.state && proposed.errors.length === 0 ? { declaration: proposed.roots } : {}),
  };
  if (proposed?.changed) plan.changes.push(`保存 ${options.scope} 插件需求：${proposed.roots.join('、')}。`);
  const preciseCleanup = (command === 'cleanup' || command === 'uninstall') && selectors.length > 0
    && options.targets !== undefined;
  try {
    receipt.selection = selectAgents({ preferences: preciseCleanup ? { state: 'absent' } : demand.preferences,
      targets: options.targets });
    receipt.requestedRoots = preciseCleanup ? [...new Set(selectors.map((selector) => {
      const parsed = parsePluginId(selector);
      if (!parsed.sourceId) throw new Error('cleanupPluginIdRequired');
      return `${parsed.sourceId}/${parsed.pluginName}`;
    }))] : selectRoots(demand, selectors, options.all ?? false);
  } catch (error) { receipt.blockers.push(diagnostic(errorCode(error, 'projectSelectionInvalid'))); }
  if (options.exactTargets && (options.exactTargets.length === 0 || options.exactTargets.some((target) =>
    !receipt.requestedRoots.includes(target.pluginId) || !receipt.selection.agents.includes(target.agent)))) {
    receipt.blockers.push(diagnostic('invalidExactTargets'));
  }
  if (!preciseCleanup) {
    if (!['valid', 'absent'].includes(demand.intent.state)) receipt.blockers.push(diagnostic('pluginIntentStateInvalid'));
  }
  if (receipt.requestedRoots.length && !receipt.selection.agents.length) receipt.blockers.push(diagnostic('localTargetsRequired'));
  if (!preciseCleanup) receipt.blockers.push(...demand.errors);
  plan.blockExecution = Boolean(proposed?.errors.length)
    || receipt.blockers.length > 0;
  for (const [sourceId, code] of refreshFailures) {
    receipt.blockers.push({ code, message: `${sourceId}：${diagnostic('sourceRefreshFailed').message}` });
  }
  for (const root of demand.roots ?? []) {
    if (!receipt.requestedRoots.includes(root.pluginId) || preciseCleanup) continue;
    receipt.blockers.push(...root.blockers.map((code) => ({ ...diagnostic(code), message: `${root.pluginId}：${diagnostic(code).message}` })));
  }
  for (const pluginId of receipt.requestedRoots) {
    const root = demand.roots?.find((entry) => entry.pluginId === pluginId);
    const agents = receipt.selection.agents;
    for (const agent of agents) {
      if (options.exactTargets
        && !options.exactTargets.some((target) => target.pluginId === pluginId && target.agent === agent)) continue;
      const resolvedDelivery = root?.plugin ? resolveDelivery(root.plugin.manifest, agent, options.scope) ?? null : null;
      const delivery = preciseCleanup ? isPortableAgent(agent)
        ? { kind: 'agent-skills' as const, provider: 'aw' as const, agentId: 'generic' as const }
        : { kind: 'native' as const, platform: agent } : resolvedDelivery;
      receipt.targetResults.push({ pluginId, agent, scope: options.scope, delivery, execution: 'not-run', observation: 'unknown',
        blockers: [...(preciseCleanup ? [] : root?.blockers ?? []).map(diagnostic),
          ...(refreshFailures.has(parsePluginId(pluginId).sourceId!)
            ? [diagnostic(refreshFailures.get(parsePluginId(pluginId).sourceId!)!)] : []),

          ...(!delivery ? [diagnostic(preciseCleanup ? 'backend-action-unsupported' : 'deliveryUnsupported')] : [])],
        requiredBy: [pluginId] });
    }
  }
  if (plan.blockExecution) return { ...plan, receipt: completeReceipt(receipt) };
  if (sourceRefreshes.length > 0) {
    for (const refresh of sourceRefreshes) {
      plan.changes.push(`刷新 Catalog 来源 ${refresh.sourceId}，确认后激活已检查的候选 generation。`);
      if (!refresh.impact.inventoryComplete) {
        plan.warnings.push(`${refresh.sourceId}：来源影响清单不完整，需要明确确认。`);
      } else if (refresh.impact.affectedReferences.length > 0) {
        plan.warnings.push(`${refresh.sourceId}：来源更新会影响 ${refresh.impact.affectedReferences.length} 个已知引用，需要明确确认。`);
      }
    }
    return { ...plan, receipt: completeReceipt(receipt) };
  }
  const groups = new Map<string, { command: RecoveryCommand; targets: NativeTarget[] }>();
  for (const target of receipt.targetResults) {
    if (target.blockers.length || target.delivery?.kind !== 'native') continue;
    const command = plan.command;
    const key = `${parsePluginId(target.pluginId).sourceId}\0${target.delivery.platform}\0${command}`;
    const group = groups.get(key) ?? { command, targets: [] };
    group.targets.push({ pluginId: target.pluginId, platform: target.delivery.platform });
    groups.set(key, group);
  }
  const preparationRuntime = { ...runtime, signal: options.signal, nativeObservationBatch };
  const pendingGroups = [...groups.values()].map((pending) => ({
    ...nativeTargetSelection(pending.targets), command: pending.command,
  }));
  const previews = await readNativeGroups(pendingGroups, async (group) => {
    try {
      const preview = await nativeOperation(plan, group.pluginIds, group.platform, true,
        preparationRuntime, group.command, group.targets, catalogReadScope);
      return { ok: true as const, preview };
    } catch (error) {
      if (recoveryInterruptionCode(error, options.signal)) throw error;
      return { ok: false as const, error };
    }
  }, options.signal);
  for (const [index, group] of pendingGroups.entries()) {
    const result = previews[index]!;
    if (result.ok) {
      const { preview } = result;
      const nativeGroup = { ...group, preview };
      plan.nativeGroups.push(nativeGroup);
      nativeResults(plan, nativeGroup, preview, false);
      plan.changes.push(...(preview.operationPlan?.changes ?? []));
      const nativeToolChanges = preview.operationPlan ? operationPlanNativeToolChanges(preview.operationPlan) : [];
      if (nativeToolChanges.length) receipt.nativeToolChanges = [...(receipt.nativeToolChanges ?? []), ...nativeToolChanges];
      for (const change of nativeToolChanges) {
        for (const [verb, closure] of [['撤销', change.before], ['使用', change.after]] as const) {
          if (closure) plan.changes.push(...describeNativeToolClosure(closure).map((description) =>
            `${verb}原生工具 · ${change.producer.sourceId}/${change.producer.pluginName} · ${change.producer.key} · ${description}`));
        }
      }
      for (const override of preview.dependencyPlan?.scopeOverrides ?? []) {
        if (options.dependencyScopeOverrides?.some((requested) => requested.pluginId === override.pluginId
          && (!requested.platform || requested.platform === override.platform))) {
          plan.changes.push(`推导的依赖提供位置：${override.pluginId}#${override.platform}=${override.scope}。`);
        }
      }
      plan.warnings.push(...preview.warnings);
    } else {
      const { error } = result;
      if (error instanceof CatalogSourceInventoryIncompleteError) {
        receipt.blockers.push(...error.inventory.errors.map(inventoryRecoveryDiagnostic));
      }
      for (const { pluginId, platform } of group.targets) {
        block(pair(plan, pluginId, agentForPlatform(platform))!, errorCode(error, 'nativePreparationFailed'));
      }
    }
  }
  const portableReads = receipt.requestedRoots.flatMap((pluginId) => {
    const agents = receipt.targetResults.filter((target) => target.pluginId === pluginId
      && !target.blockers.length && target.delivery?.kind === 'agent-skills').map((target) => target.agent).filter(isPortableAgent);
    return agents.length ? [{ pluginId, agents }] : [];
  });
  const preparedGroups = await mapInstallReads(portableReads, async ({ pluginId, agents }) => {
    try {
      const prepared = command === 'cleanup' || command === 'uninstall'
        ? await preparePortableCleanup({ scope: options.scope, context, selector: pluginId, agents, force: options.force, signal: options.signal })
        : await preparePortableRecovery({ scope: options.scope, context, selector: pluginId, agents,
          env: options.env, cliVersion: options.cliVersion, signal: options.signal,
          catalogOperationContext: demand.catalogOperationContext, excludedPluginIds: options.excludedPluginIds }, catalogReadScope, portableGenerations);
      return { ok: true as const, prepared };
    } catch (error) {
      if (recoveryInterruptionCode(error, options.signal)) throw error;
      return { ok: false as const, agents, pluginId, code: errorCode(error, 'portablePreparationFailed') };
    }
  }, { signal: options.signal });
  for (const result of preparedGroups) {
    if (result.ok) plan.portableGroups.push(result.prepared);
    else for (const agent of result.agents) block(pair(plan, result.pluginId, agent)!, result.code);
  }
  for (const prepared of plan.portableGroups) portableResults(plan, prepared);
  preparePortablePreApplyAuthorization(plan);
  if (command !== 'cleanup' && command !== 'uninstall') {
    // Complete scope demand protects copies contributed by unselected roots and their dependencies.
    const desiredAgents = new Set([...receipt.selection.agents,
      ...(demand.preferences.state === 'valid' ? demand.preferences.value.targets : [])]);
    const protection = await mapInstallReads(demand.roots ?? [], async (root) => {
      const portableAgents = [...desiredAgents].filter(isPortableAgent).filter((agent) => root.plugin
        && resolveDelivery(root.plugin.manifest, agent, options.scope)?.kind === 'agent-skills');
      if (!portableAgents.length || plan.portableGroups.some((group) => group.options.selector === root.pluginId
        && portableAgents.every((agent) => group.options.agents.includes(agent)))) return;
      try {
        const prepared = await preparePortableRecovery({ scope: options.scope, context, selector: root.pluginId,
            env: options.env, agents: portableAgents, cliVersion: options.cliVersion, signal: options.signal,
            catalogOperationContext: demand.catalogOperationContext, excludedPluginIds: options.excludedPluginIds }, catalogReadScope, portableGenerations);
        if (!prepared.globalBlockers.length) return prepared;
      } catch (error) {
        if (recoveryInterruptionCode(error, options.signal)) throw error;
        // Missing current Portable evidence cannot protect historical residue.
      }
    }, { signal: options.signal });
    plan.portableProtectionGroups = protection.filter((prepared) => prepared !== undefined);
  }

  options.signal?.throwIfAborted();
  await checkFootprints(plan);
  options.signal?.throwIfAborted();
  for (const prepared of [...plan.portableGroups, ...plan.portableProtectionGroups]) {
    delete prepared.options.signal;
  }
  plan.plannedImpact.outputs = !plan.blockExecution && (
    plan.nativeGroups.some((group) => (group.preview.operationPlan?.actions.length ?? 0) > 0
      && nativeGroupTargets(group).some(({ pluginId, platform }) =>
        pair(plan, pluginId, agentForPlatform(platform))?.blockers.length === 0))
    || (plan.portableGroups.some((group) =>
      group.targets.some((target) => pair(plan, group.options.selector, target.agent)?.blockers.length === 0
        && (group.mode === 'cleanup' || target.observation === 'absent' || target.observation === 'drifted'
          || (command === 'reinstall' && target.observation === 'satisfied' && target.ownership === 'aw'))))));
  completeReceipt(receipt);
  return plan;
  } catch (error) {
    await context.dispose();
    throw error;
  }
}

export async function activateRecoverySourcesAndReprepare(
  plan: RecoveryPlan,
  execution: { runtime?: RebuildCommandRuntime } = {},
): Promise<RecoveryPlan> {
  if (plan.sourceRefreshes.length === 0) return plan;
  const runtime = { ...plan.runtime, ...execution.runtime };
  const failures = new Map(plan.sourceRefreshFailures.map(({ sourceId, code }) => [sourceId, code]));
  try {
    for (const refresh of plan.sourceRefreshes) {
      try {
        await activateCatalogSourceGeneration({
          sourceId: refresh.sourceId,
          cliVersion: plan.options.cliVersion,
          cwd: plan.options.cwd,
          env: plan.options.env,
          impactConfirmed: true,
          expectedImpactDigest: refresh.impactDigest,
          expectedCandidate: refresh.candidate,
          expectedActive: refresh.previousActive,
          expectedConfigDigest: refresh.configDigest,
          runtime: runtime.catalogGenerationRuntime,
        });
      } catch (error) {
        const code = errorCode(error, 'catalogGenerationRefreshFailed');
        failures.set(refresh.sourceId, code.startsWith('catalog') ? code : 'catalogGenerationRefreshFailed');
      }
    }
    const failedSourceIds = new Set(failures.keys());
    const originalExactTargets = plan.options.exactTargets
      ?? plan.receipt.targetResults.map(({ pluginId, agent }) => ({ pluginId, agent }));
    const exactTargets = failures.size > 0
      ? originalExactTargets.filter((target) =>
        !failedSourceIds.has(parsePluginId(target.pluginId).sourceId!))
      : plan.options.exactTargets;
    const next = await prepareRecovery(plan.command, plan.receipt.requestedRoots, {
      ...plan.options,
      all: false,
      refresh: false,
      ...(exactTargets ? { exactTargets } : {}),
    }, { ...runtime, preparedArtifactRenderResults: new Map() });
    if (failures.size === 0) return next;
    if (exactTargets?.length === 0) {
      next.receipt.blockers = next.receipt.blockers.filter((entry) => entry.code !== 'invalidExactTargets');
      next.blockExecution = true;
    }
    for (const [sourceId, code] of failures) {
      next.receipt.blockers.push({ code, message: `${sourceId}：${diagnostic('sourceRefreshFailed').message}` });
    }
    for (const target of plan.receipt.targetResults) {
      const sourceId = parsePluginId(target.pluginId).sourceId!;
      const code = failures.get(sourceId);
      if (!code || next.receipt.targetResults.some((entry) =>
        entry.pluginId === target.pluginId && entry.agent === target.agent)) continue;
      const failed = structuredClone(target);
      block(failed, code);
      next.receipt.targetResults.push(failed);
    }
    next.receipt = completeReceipt(next.receipt);
    return next;
  } finally {
    await plan.context.dispose();
  }
}

function portablePrewriteBinding(context: CatalogOperationContext | undefined, sourceId: string): string | undefined {
  const source = context?.catalog.sources[0]?.resolution;
  const generation = context?.generationSet.sources[0];
  if (!context || context.catalog.sources.length !== 1 || context.generationSet.sources.length !== 1
    || !source || !generation || source.sourceId !== sourceId || generation.sourceId !== sourceId
    || source.rootDir !== generation.snapshotPath || source.sourceIdentity !== generation.sourceIdentity
    || source.logicalIdentity !== generation.logicalIdentity || source.resolvedCommit !== generation.resolvedCommit
    || source.manifestDigest !== generation.manifestDigest || source.snapshotDigest !== generation.snapshotDigest) return;
  return JSON.stringify([context.generationSetDigest,
    createCatalogPreparationStoreKey({ ...generation, requestedRef: source.requestedRef })]);
}

async function recheckPortableRecovery(plan: RecoveryPlan, groups: readonly PortablePreparation[] = plan.portableGroups,
  progress?: CheckedPortableProgress): Promise<RecoveryDiagnostic | undefined> {
  const inspections = [
    ...groups.filter(({ options }) => !options.agents.every((agent) => pair(plan, options.selector, agent)?.blockers.length)),
    ...plan.portableProtectionGroups,
    ...new Set(groups.flatMap((group) => plan.options.portableProviderChecks?.get(group.options.selector) ?? [])),
  ];
  if (!inspections.length) return;
  const readScope = new CatalogPreparationReadScope({ env: plan.context.env, signal: plan.runtime.signal });
  const active = new Map<string, Promise<CatalogOperationContext>>();
  const problems = await mapInstallReads(inspections, async (prepared) => {
    let current: CatalogOperationContext | undefined;
    const sourceId = parsePluginId(prepared.options.selector).sourceId;
    const reviewed = prepared.options.catalogOperationContext;
    if (sourceId && reviewed && prepared.mode === 'deploy') {
      try {
        let pending = active.get(sourceId);
        if (!pending) { pending = readScope.resolve({ sourceIds: [sourceId] }, true); active.set(sourceId, pending); }
        current = await pending;
        const original = selectCatalogOperationContext(reviewed, [sourceId]);
        if (portablePrewriteBinding(current, sourceId) !== portablePrewriteBinding(original, sourceId)) {
          return diagnostic('operationReviewStale');
        }
      } catch (error) {
        if (recoveryInterruptionCode(error, plan.runtime.signal)) throw error;
        return { ...diagnostic('operationReviewStale'), subject: { sourceId },
          detail: { reasonCode: error instanceof CatalogGenerationError ? error.code : 'catalogReadFailed' } };
      }
    }
    const checked = await inspectPortableRecovery({ ...prepared.options, catalogOperationContext: current,
      signal: plan.runtime.signal }, readScope);
    if (!portableReviewMatches(prepared, checked, progress?.completed)) return diagnostic('operationReviewStale');
  }, { signal: plan.runtime.signal });
  return problems.find((problem) => problem !== undefined);
}

async function executeNativeGroup(plan: RecoveryPlan, group: NativeGroup, nativeRuntime: RebuildCommandRuntime): Promise<void> {
  const { receipt } = plan;
  const running = new Set<RecoveryTarget>();
  try {
    const result = await nativeOperation(plan, group.pluginIds, group.platform, false,
      { ...nativeRuntime, onInstallTargetState(identity, state) {
        const target = identity.scope === plan.options.scope && identity.pluginId
          ? pair(plan, identity.pluginId, identity.platform) : undefined;
        if (target && state === 'running') running.add(target);
        else if (target) running.delete(target);
        nativeRuntime.onInstallTargetState?.(identity, state);
      }, expectedPlanFingerprint: group.preview.operationPlan?.planFingerprint },
      group.command, nativeGroupTargets(group));
    receipt.outputsMayHaveChanged ||= result.rebuildResults.some((result) => result.actions.some((action) =>
      action.name === 'stale.cleanup' || action.name === 'native.write' || action.name === 'artifacts.write'
        || action.name === 'recovery.cleanup' || action.name === 'cleanup.owned'))
      || ((result.commandResults?.length ?? 0) > 0
        && result.operationPlan?.actions.some((action) => action.kind === 'syncManagedCommandPackage') === true);
    nativeResults(plan, group, result, true);
  } catch (error) {
    if (error instanceof RebuildInterruptedError) {
      const recorded = error.result;
      const targets = nativeGroupTargets(group).filter(({ pluginId, platform }) =>
        recorded.targetResults.some((entry) => entry.target.pluginId === pluginId && entry.target.platform === platform));
      nativeResults(plan, { ...group, targets }, recorded, true);
      receipt.outputsMayHaveChanged ||= recorded.rebuildResults.some((entry) =>
        entry.actions.length > 0 || entry.deploymentReceipts?.some((deployment) =>
          deployment.effects.some((effect) => effect.mutation !== 'none')))
        || recorded.commandResults?.some((command) => command.state === 'completed') === true;
    }
    const interruption = recoveryInterruptionCode(error, nativeRuntime.signal);
    if (interruption) {
      for (const target of running) {
        target.execution = 'partial'; target.observation = 'unknown'; target.content = 'unknown';
        block(target, interruption);
        receipt.outputsMayHaveChanged = true;
      }
      throw error;
    }
    const code = errorCode(error, 'nativeRecoveryFailed');
    receipt.outputsMayHaveChanged ||= code !== 'preApplyAuthorizationRequired';
    for (const { pluginId, platform } of nativeGroupTargets(group)) {
      const target = pair(plan, pluginId, agentForPlatform(platform))!;
      target.execution = 'failed'; block(target, code); }
  }
}

async function executePortableGroups(plan: RecoveryPlan, groups: readonly PortablePreparation[],
  nativeRuntime: RebuildCommandRuntime, progress: CheckedPortableProgress, jointChecked = false): Promise<void> {
  const { receipt } = plan;
  for (const prepared of groups) {
    let started = false;
    const onStart = () => {
      if (started) return;
      started = true;
      try { nativeRuntime.onInstallTargetState?.({ pluginId: prepared.options.selector,
        platform: 'generic', scope: plan.options.scope }, 'running'); }
      catch { /* Display callbacks don't control execution. */ }
    };
    const providers = plan.options.portableProviderChecks?.get(prepared.options.selector);
    const checkPrewrite = jointChecked || providers?.length ? () => recheckPortableRecovery(plan, [prepared], progress) : undefined;
    const agents: PortableAgent[] = [];
    for (const agent of prepared.options.agents) {
      if (pair(plan, prepared.options.selector, agent)!.blockers.length) continue;
      const outcomes: PortableExecutionTarget[] = prepared.targets.filter((entry) => entry.agent === agent).map((entry) => {
        const failed = progress.failed.find((failure) => failure.logicalIdentity === prepared.logicalIdentity
          && failure.outcome.physicalPath === entry.physicalPath && failure.outcome.expectedDigest === entry.expectedDigest
          && failure.outcome.providerPluginId === entry.providerPluginId);
        return failed ? { ...failed.outcome, agent } : { ...entry, execution: 'not-run', blockers: [] };
      });
      if (outcomes.some((entry) => entry.execution === 'failed')) {
        portableOutcomes(plan, prepared, agent, outcomes, []);
        continue;
      }
      const hasScript = plan.preApplyAuthorization?.some((target) => target.platform === agent
        && portablePluginClosure(plan, prepared).some((plugin) => plugin.pluginId === target.pluginId));
      const preApply = async () => {
        onStart();
        const stale = await checkPrewrite?.();
        if (stale) { receipt.blockers.push(stale); return stale.code; }
        return executePortablePreApply(plan, prepared, agent, nativeRuntime);
      };
      const preApplyFailure = !hasScript ? undefined : nativeRuntime.installAdmission
        ? await nativeRuntime.installAdmission.run([{ kind: 'exclusive' }], preApply, nativeRuntime.signal) : await preApply();
      if (preApplyFailure) {
        const target = pair(plan, prepared.options.selector, agent)!;
        portableOutcomes(plan, prepared, agent, prepared.targets.filter((entry) => entry.agent === agent)
          .map((entry) => unobservedPortableTarget(entry, preApplyFailure)), [preApplyFailure]);
        if (preApplyFailure !== 'operationReviewStale') target.execution = 'failed';
        target.recoveryActions = [`aw plugin sync ${target.pluginId} --context ${target.scope} --target ${agent}`
          + (preApplyFailure === 'operationReviewStale' ? '' : ' --yes')];
        continue;
      }
      agents.push(agent);
    }
    if (!agents.length) continue;
    let interruption: PortableInterruptedError | undefined;
    const result = await executePortableRecovery({ prepared, token: nativeRuntime.awHomeMutationToken!, authorizeUpdate: plan.options.yes,
      action: plan.command === 'install' ? 'sync' : plan.command, force: plan.options.force,
      targets: prepared.targets.filter((target) => agents.includes(target.agent)).map(({ skill, agent }) => ({ skill, agent })),
      progress, checkPrewrite, readProviders: providers, onStart, admission: nativeRuntime.installAdmission, signal: nativeRuntime.signal }).catch((error) => {
      if (!(error instanceof PortableInterruptedError)) throw error;
      interruption = error;
      return error.result;
    });
    if (result.reviewProblem) receipt.blockers.push(result.reviewProblem);
    receipt.outputsMayHaveChanged ||= result.outputsMayHaveChanged;
    for (const agent of agents) {
      portableOutcomes(plan, prepared, agent, result.targets.filter((entry) => entry.agent === agent), result.globalBlockers);
      if (interruption && result.outputsMayHaveChanged) {
        const target = pair(plan, prepared.options.selector, agent)!;
        if (target.execution === 'failed') target.execution = 'partial';
      }
    }
    if (interruption) throw interruption.cause;
  }
}

/** The joint coordinator holds the write lock and has checked this complete child against Review. */
export async function executeCheckedScopedInstall(child: RecoveryPlan, execution: {
  runtime: RebuildCommandRuntime; yes?: boolean; pluginIds?: readonly string[]; portableProgress: CheckedPortableProgress;
}): Promise<RecoveryReceipt> {
  if (!execution.runtime.awHomeMutationToken || child.command !== 'sync' && child.command !== 'reinstall') {
    throw new Error('checkedScopedInstallUnavailable');
  }
  const selected = (pluginId: string) => !execution.pluginIds || execution.pluginIds.includes(pluginId);
  const receipt = structuredClone({ ...child.receipt,
    targetResults: child.receipt.targetResults.filter((target) => selected(target.pluginId)),
    requestedRoots: child.receipt.requestedRoots.filter(selected),
  });
  const plan = { ...child, receipt, runtime: { ...child.runtime, ...execution.runtime }, options: { ...child.options, yes: execution.yes ?? child.options.yes } };
  if (receipt.nativeToolChanges?.length && plan.options.yes !== true) {
    receipt.blockers.push(diagnostic('nativeToolAuthorizationRequired'));
    return completeReceipt(receipt);
  }
  if (plan.blockExecution) return completeReceipt(receipt);
  const runtime = plan.runtime;
  try {
    for (const group of plan.nativeGroups) {
      const targets = nativeGroupTargets(group);
      const blocked = new Map<string, string>();
      for (const { pluginId, platform } of targets) {
        const code = pair(plan, pluginId, platform)?.blockers[0]?.code;
        if (code) blocked.set([pluginId, platform, plan.options.scope].join('\0'), code);
      }
      if (blocked.size === targets.length) continue;
      await executeNativeGroup(plan, group, { ...runtime, nativeInstallBlockers: blocked });
    }
    await executePortableGroups(plan, plan.portableGroups.filter((group) => selected(group.options.selector)), runtime, execution.portableProgress, true);
    return completeReceipt(receipt);
  } catch (error) {
    const code = recoveryInterruptionCode(error, runtime.signal);
    if (!code) throw error;
    receipt.blockers.push(diagnostic(code));
    throw new RecoveryInterruptedError(completeReceipt(receipt), error);
  }
}

export async function executeScopedRecovery(plan: RecoveryPlan,
  execution: { yes?: boolean; runtime?: RebuildCommandRuntime } = {}): Promise<RecoveryReceipt> {
  if (plan.sourceRefreshes.length > 0) {
    const receipt = structuredClone(plan.receipt);
    receipt.blockers.push(diagnostic('sourceRefreshConfirmationRequired'));
    await plan.context.dispose();
    return completeReceipt(receipt);
  }
  const receipt = structuredClone(plan.receipt);
  plan = { ...plan, receipt, options: { ...plan.options, yes: execution.yes ?? plan.options.yes },
    runtime: { ...plan.runtime, ...execution.runtime } };
  try {
  if (receipt.nativeToolChanges?.length && plan.options.yes !== true) {
    receipt.blockers.push(diagnostic('nativeToolAuthorizationRequired'));
    return completeReceipt(receipt);
  }
  const freshContext = await createScopeContext({ scope: plan.options.scope,
    cwd: plan.context.callerCwd, env: plan.options.env });
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
    return completeReceipt(receipt);
  }
  return await withAwHomeMutationLock({ env: plan.options.env, token: plan.runtime.awHomeMutationToken,
    action: async (token) => {
      const [actualIntent, current] = await Promise.all([
        observeIntent(plan.options),
        readDemand({ ...plan.options, preferences: undefined,
          ...(plan.declaration || plan.options.demandOverride ? { intent: plan.demand.intent } : {}) }),
      ]);
      if (intentEvidence(actualIntent) !== plan.originalIntent || preferenceEvidence(current) !== plan.preferencesEvidence
        || current.catalogOperationContext?.generationSetDigest !== plan.demand.catalogOperationContext?.generationSetDigest) {
        receipt.blockers.push(diagnostic('operationReviewStale'));
        return completeReceipt(receipt);
      }
      const previewManager = plan.nativeGroups.map((group) => group.preview.codexManagerPreview)
        .find((entry) => entry?.state === 'system');
      const session = plan.runtime.codexObservationSession ?? (plan.nativeGroups.length ? await createCodexNativeObservationSession({
        exactCwd: plan.context.executionCwd, env: plan.context.env,
        runner: plan.runtime.nativeCliRunner ?? getDefaultNativeCliRunner(),
        manager: plan.runtime.codexManager ?? (previewManager?.state === 'system'
          ? previewManager.manager : undefined),
      }) : undefined);
      const nativeRuntime = { ...plan.runtime, awHomeMutationToken: token,
        managedCommandProducerCache: plan.runtime.managedCommandProducerCache
          ?? new Map<string, Promise<CommandProducerResult>>(),
        ...(session ? { codexObservationSession: session } : {}) };
      try {
      // Freeze every backend before the first declaration or output write.
      const recheckedGroups = await readNativeGroups(plan.nativeGroups, async (group) => {
        const targets = nativeGroupTargets(group);
        const executable = targets.filter(({ pluginId, platform }) =>
          !pair(plan, pluginId, agentForPlatform(platform))!.blockers.length);
        if (!executable.length) return;
        const checked = await nativeOperation(plan, group.pluginIds, group.platform, true,
          nativeRuntime, group.command, targets);
        if (checked.operationPlan?.planFingerprint !== group.preview.operationPlan?.planFingerprint) return 'stale' as const;
        const selection = nativeTargetSelection(executable);
        const preview = executable.length === targets.length ? checked
          : await nativeOperation(plan, selection.pluginIds, selection.platform, true,
              nativeRuntime, group.command, executable);
        return { ...group, ...selection, preview };
      }, nativeRuntime.signal);
      if (recheckedGroups.includes('stale')) {
        receipt.blockers.push(diagnostic('operationReviewStale'));
        return completeReceipt(receipt);
      }
      const executableNativeGroups = recheckedGroups.filter((group) => group !== undefined && group !== 'stale');
      const portableBlocker = await recheckPortableRecovery(plan);
      if (portableBlocker) {
        receipt.blockers.push(portableBlocker);
        return completeReceipt(receipt);
      }
      for (const residue of plan.portableResidues) {
        const checked = await inspectPortableResidue({ scope: plan.options.scope, context: plan.context,
          selector: residue.pluginId, env: plan.options.env, agents: residue.agents.filter(isPortableAgent),
          retainedTargets: residue.retainedTargets }).catch(() => undefined);
        if (!checked || JSON.stringify(checked) !== JSON.stringify(residue.observation)) {
          receipt.blockers.push(diagnostic('operationReviewStale'));
          return completeReceipt(receipt);
        }
      }
      if (plan.declaration) {
        const declared = await addRequirements({ ...plan.options, selectors: plan.declaration, token });
        receipt.declarationChanged = declared.changed;
        receipt.blockers.push(...declared.errors);
        plan.blockExecution ||= declared.errors.length > 0;
        const intent = await observeIntent(plan.options);
        receipt.intent = { ...receipt.intent, state: intent.state, ...('digest' in intent ? { digest: intent.digest } : {}) };
      }
      if (plan.blockExecution) return completeReceipt(receipt);
      if (plan.preferences) {
        try {
          const saved = await writePreferences({ ...plan.options, token }, plan.preferences);
          receipt.preferencesChanged = saved.changed;
        } catch (error) {
          receipt.blockers.push(diagnostic(errorCode(error, 'deploymentPreferencesWriteFailed')));
          return completeReceipt(receipt);
        }
      }
      for (const group of executableNativeGroups) await executeNativeGroup(plan, group, nativeRuntime);
      await executePortableGroups(plan, plan.portableGroups, nativeRuntime, { completed: [], failed: [] });
      for (const { kind, pluginId, observation } of plan.portableResidues) {
        if (kind !== 'cleanup') continue;
        if (observation.state === 'absent') continue;
        const targets = receipt.targetResults.filter((target) => target.pluginId === pluginId
          && (observation.targets.some((entry) => entry.agent === target.agent)
            || (observation.unknownAgents?.some((item) => item === target.agent)
              ?? (observation.blockers.length > 0))));
        for (const target of targets) {
          block(target, isPortableAgent(target.agent) && observation.unknownAgents?.some((item) => item === target.agent)
            || !observation.targets.some((entry) => entry.agent === target.agent)
              ? 'portableObservationFailed' : 'backend-action-unsupported');
          if (target.execution === 'applied') target.execution = 'partial';
          target.backend = { ...(target.delivery?.kind === 'native' ? { native: target.backend } : { portable: target.backend }), portableRemaining: {
            state: observation.state, targets: observation.targets.map(({ skill, agent, physicalPath }) =>
              ({ skill, agent, physicalPath: displayPortablePath(plan, physicalPath) })),
          } };
          target.recoveryActions = [...new Set([...(target.recoveryActions ?? []), ...portableRecoveryActions(plan, pluginId,
            observation.targets.filter((entry) => entry.agent === target.agent))])];
        }
      }
      if (receipt.declarationChanged) {
        const intent = await observeIntent(plan.options);
        receipt.intent = { state: intent.state, ...('digest' in intent ? { digest: intent.digest } : {}),
          roots: intent.state === 'valid' ? intent.value.roots.map((root) => root.pluginId) : null };
      }
      return completeReceipt(receipt);
      } finally { if (!plan.runtime.codexObservationSession) await session?.dispose(); }
    } });
  } finally {
    await plan.context.dispose();
  }
}

export async function runRecovery(command: RecoveryCommand, selectors: readonly string[],
  options: RecoveryOptions, runtime: RebuildCommandRuntime = {}): Promise<RecoveryReceipt> {
  let plan = await prepareRecovery(command, selectors, options, runtime);
  if (plan.sourceRefreshes.length > 0) {
    if (options.yes !== true) {
      if (!options.interactive || !options.prompt?.confirm) {
        plan.receipt.blockers.push(diagnostic('sourceRefreshConfirmationRequired'));
        await plan.context.dispose();
        return completeReceipt(plan.receipt);
      }
      const response = await options.prompt.confirm({ defaultValue: false, message: [
        `先更新来源：${plan.sourceRefreshes.map((entry) => entry.sourceId).join('、')}。`,
        ...plan.changes,
        ...plan.warnings,
        '确认后只激活已检查的来源候选；随后会基于新的 Active 重新准备插件恢复，并再次确认。',
      ].join('\n') });
      if (response.cancelled || response.value !== true) {
        plan.receipt.blockers.push(diagnostic('operationCancelled'));
        await plan.context.dispose();
        return completeReceipt(plan.receipt);
      }
    }
    plan = await activateRecoverySourcesAndReprepare(plan, { runtime });
  }
  if (options.interactive && options.yes !== true && options.prompt?.confirm
    && (plan.declaration || plan.receipt.targetResults.some((target) => target.blockers.length === 0))) {
    const response = await options.prompt.confirm({ defaultValue: false, message: [
      `${options.scope} 请求：${plan.receipt.requestedRoots.join('、')}；Agent：${plan.receipt.selection.agents.join('、') || '未选择'}。`,
      ...plan.receipt.targetResults.map((target) => `${target.pluginId} / ${target.agent}：${target.blockers.length
        ? `受阻（${target.blockers.map((entry) => entry.code).join('、')}）` : '可执行'}`),
      ...plan.changes, ...plan.warnings, ...plan.receipt.blockers.map((entry) => entry.message),
      '是否执行以上可处理变更及计划中的 preApply 脚本？',
    ].join('\n') });
    if (response.cancelled || response.value !== true) {
      plan.receipt.blockers.push(diagnostic('operationCancelled'));
      await plan.context.dispose();
      return completeReceipt(plan.receipt);
    }
    return executeRecovery(plan, { yes: true, runtime: { preApplyConfirmed: true } });
  }
  return executeRecovery(plan);
}

export async function prepareRecovery(command: RecoveryCommand, selectors: readonly string[],
  options: RecoveryOptions, runtime: RebuildCommandRuntime = {}): Promise<RecoveryPlan> {
  const preparedResults = runtime.preparedArtifactRenderResults ?? new Map();
  runtime = { ...runtime, preparedArtifactRenderResults: preparedResults };
  return measureRecoveryPerformanceStage(runtime, 'recovery.plan', async () => {
    try {
      if (command === 'cleanup' && !options.scope) throw new Error('cleanupScopeRequired');
      const plan = command === 'cleanup'
        ? await prepareScopedRecovery(command, selectors, { ...options, scope: options.scope! }, runtime)
        : await prepareJointRecovery(command, selectors, options, runtime);
      const dispose = plan.context.dispose;
      let disposed = false;
      plan.context.dispose = async () => {
        if (disposed) return;
        disposed = true;
        try { await dispose(); }
        finally { await disposePreparedPlatformRebuildSession(preparedResults); }
      };
      return plan;
    } catch (error) {
      await disposePreparedPlatformRebuildSession(preparedResults);
      throw error;
    }
  });
}

export async function executeRecovery(plan: RecoveryPlan,
  execution: { yes?: boolean; runtime?: RebuildCommandRuntime } = {}): Promise<RecoveryReceipt> {
  return plan.joint ? executeJointRecovery(plan, execution) : executeScopedRecovery(plan, execution);
}

/** Review evidence uses existing backend fingerprints and observation digests; it is not stored state. */
export function describeRecoveryPlan(plan: RecoveryPlan): unknown {
  const describe = (child: RecoveryPlan) => ({ scope: child.options.scope, targets: child.receipt.requestedTargets,
    native: child.nativeGroups.map((group) => group.preview.operationPlan?.planFingerprint),
    preApplyAuthorization: child.preApplyAuthorization,
    nativeActivationOnlyTargets: child.options.nativeActivationOnlyTargets,
    nativePlannedRetirements: child.options.nativePlannedRetirements,
    portable: child.portableGroups.map((group) => group.evidenceDigest),
    inheritedPortable: child.options.portableProviderChecks?.size
      ? [...child.options.portableProviderChecks].map(([root, providers]) => [root, providers.map((item) => item.evidenceDigest)]) : undefined,
    protectedPortable: child.portableProtectionGroups.map((group) => group.evidenceDigest),
    residue: child.portableResidues, blockers: child.receipt.blockers,
    targetBlockers: child.receipt.targetResults.map((target) => target.blockers),
    environment: { homes: child.context.targetHomes, projectRoot: child.context.projectRoot, awHome: child.context.awHome },
  });
  return { inputs: plan.joint?.evidence ?? [plan.originalIntent, plan.preferencesEvidence],
    catalog: plan.command === 'install' ? plan.demand.catalogOperationContext?.generationSetDigest : undefined,
    command: plan.command, dependencyCleanupTargets: plan.dependencyCleanupTargets,
    declaration: plan.joint?.declaration, packages: plan.runtime.configApplyPackages ? { targets: plan.runtime.configApplyPackages.targets, evidence: plan.runtime.configApplyPackages.evidence } : undefined, blockers: plan.receipt.blockers,
    children: (plan.joint?.children ?? [plan]).map(describe) };
}
