import path from 'node:path';

import type {
  CatalogGenerationActiveV1,
  CatalogGenerationCandidateEvidence,
  CatalogSourceImpact,
  InstallCommandOptions,
  PlatformName,
  Scope,
} from '../types.js';
import type { CliPrompt } from '../commands/runtime.js';
import { runRebuildCommand, type RebuildCommandResult, type RebuildCommandRuntime } from '../commands/rebuild-command.js';
import { buildRebuildReceiptJson } from '../output/command-receipt.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { createCodexNativeObservationSession } from '../utils/codex-native-observation.js';
import { bindNativeCliRunnerSignal, getDefaultNativeCliRunner } from '../utils/native-cli.js';
import { portableRecoveryLayout } from '../portable/recovery-layout.js';
import { SkillsCliError } from '../portable/skills-cli.js';
import { canonicalizePathThroughExistingAncestor } from '../utils/state-paths.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
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
  inspectPortableRecovery,
  inspectPortableResidue,
  executePortableRecovery,
  type PortablePreparation,
  type PortableExecutionTarget,
  type PortableResidue,
  type PortableTarget,
} from '../portable/recovery.js';
import { addRequirements } from '../commands/intent-command.js';
import { readDemand, demandNativeProjection, resolveDelivery, type DemandSnapshot } from './demand.js';
import { selectAgents, createEmptyPreferences, validateDependencyScopeOverrides, writePreferences,
  type AgentId, type DeploymentPreferences } from '../intent/deployment-preferences.js';
import { calculateIntentDigest } from '../intent/intent-codec.js';
import { observeIntent } from '../intent/intent-store.js';
import { assertNeutralAncestorChain, createScopeContext, type ScopeContext } from '../intent/scope-context.js';
import type { RecoveryDiagnostic, RecoveryReceipt, RecoveryTarget } from './receipt.js';
import { createEmptyNativeDemandView } from '../utils/native-demand.js';

export type RecoveryCommand = 'sync' | 'install' | 'reinstall' | 'uninstall' | 'cleanup';
export interface RecoveryOptions {
  signal?: AbortSignal;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cliVersion: string;
  targets?: readonly string[];
  all?: boolean;
  yes?: boolean;
  force?: boolean;
  refresh?: boolean;
  allowManagedCodexInstall?: boolean;
  scriptTimeoutMs?: number;
  interactive?: boolean;
  prompt?: CliPrompt;
  exactTargets?: readonly { pluginId: string; agent: AgentId }[];
  dependencyScopeOverrides?: InstallCommandOptions['dependencyScopeOverrides'];
  saveDependencyScopeOverrides?: boolean;
}
interface NativeGroup {
  pluginIds: string[];
  platform: PlatformName;
  command: RecoveryCommand;
  preview: RebuildCommandResult;
}
interface Footprint {
  path: string;
  pluginIds: string[];
  agent: AgentId;
  identity: string;
  sharedNative?: boolean;
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
  options: RecoveryOptions;
  receipt: RecoveryReceipt;
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
  historicalNativeTargets: Set<string>;
  deliverySwitchChecks: Array<{ pluginIds: string[]; cleanPluginIds: string[];
    platform: PlatformName; fingerprint: string }>;
  portableGroups: PortablePreparation[];
  portableProtectionGroups: PortablePreparation[];
  runtime: RebuildCommandRuntime;
  portableResidues: Array<{ kind: 'cleanup' | 'delivery-switch'; pluginId: string;
    agents: AgentId[]; observation: PortableResidue; retainedTargets?: PortableTarget[] }>;
  sourceRefreshes: RecoverySourceRefresh[];
  sourceRefreshFailures: Array<{ sourceId: string; code: string }>;
  blockExecution: boolean;
}

function diagnostic(code: string): RecoveryDiagnostic {
  const messages: Record<string, string> = {
    localTargetsRequired: '已有需求，请先设置本机 Agent 或使用 --target。',
    deliveryUnsupported: '此插件没有适用于所选 Agent 的交付。',
    operationReviewStale: '确认依据已改变，请重新检查并确认。',
    syncPluginNotDesired: '所选插件尚未声明，请先运行 aw intent add。',
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
function errorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown })?.code;
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
  return platform === 'claude' ? 'claude-code' : 'codex';
}
function pair(plan: RecoveryPlan, pluginId: string, agent: AgentId): RecoveryTarget | undefined {
  return plan.receipt.targetResults.find((target) => target.pluginId === pluginId && target.agent === agent);
}
function block(target: RecoveryTarget, code: string): void {
  if (!target.blockers.some((entry) => entry.code === code)) target.blockers.push(diagnostic(code));
}
function completeReceipt(receipt: RecoveryReceipt): RecoveryReceipt {
  receipt.requestedTargets = receipt.targetResults.map(({ pluginId, agent, scope, delivery }) => ({ pluginId, agent, scope, delivery }));
  receipt.remainingTargets = receipt.targetResults.filter((target) => target.blockers.length > 0
    || !['applied', 'no-op'].includes(target.execution))
    .map(({ pluginId, agent, scope, delivery }) => ({ pluginId, agent, scope, delivery }));
  receipt.ok = receipt.blockers.length === 0 && receipt.remainingTargets.length === 0;
  receipt.errors = [...receipt.blockers];
  receipt.recoveryActions = receipt.ok ? [] : [...new Set([
    ...receipt.blockers.map((entry) => entry.code === 'localTargetsRequired'
      ? `aw targets set <agent...> --scope ${receipt.scope}` : `aw status --scope ${receipt.scope} --json`),
    ...receipt.remainingTargets.flatMap((target) => {
      const result = receipt.targetResults.find((entry) => entry.pluginId === target.pluginId && entry.agent === target.agent);
      if (result?.recoveryActions?.length) return result.recoveryActions;
      return result?.blockers.some((entry) => entry.code === 'backend-action-unsupported' || entry.code === 'portableObservationFailed')
        ? `检查 ${target.pluginId} 的 Portable 输出及 provider 关联；AW 不支持安全自动删除。`
        : `aw sync ${target.pluginId} --scope ${receipt.scope} --target ${target.agent}`;
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
    const shared = target.agent === 'codex' || target.agent === 'cursor'
      ? '该目录可能同时被 Codex 和 Cursor 读取；移开前请确认对两者的影响。' : `该目录供 ${target.agent} 使用。`;
    return `${pluginId}：请检查并备份目录 ${directory}；确认归属后可自行移开。${shared}`
      + (plan.command === 'cleanup' || plan.command === 'uninstall'
        ? 'AW 不自动删除此 Portable 目录；处理后重新检查状态。'
        : `然后重试 aw sync ${pluginId} --scope ${plan.options.scope} --target ${target.agent}。`);
  }))];
}

function selectRoots(demand: DemandSnapshot, selectors: readonly string[], all: boolean): string[] {
  const roots = demand.roots?.map((root) => root.pluginId) ?? [];
  if (all && selectors.length) throw new Error('syncSelectorConflict');
  if (all) return roots;
  if (!selectors.length && roots.length) throw new Error('syncSelectionRequired');
  return [...new Set(selectors.map((selector) => {
    const parsed = parsePluginId(selector);
    const matches = roots.filter((id) => parsed.sourceId ? id === selector
      : parsePluginId(id).pluginName === parsed.pluginName);
    if (matches.length !== 1) throw new Error('syncPluginNotDesired');
    return matches[0]!;
  }))];
}

async function nativeOperation(plan: RecoveryPlan, pluginIds: string[], platform: PlatformName,
  preview: boolean, runtime: RebuildCommandRuntime = plan.runtime,
  command: RecoveryCommand = plan.command): Promise<RebuildCommandResult> {
  const rebuildCommand = command === 'install' ? 'sync' : command;
  const result = await runRebuildCommand({
    command: rebuildCommand,
    pluginNames: pluginIds,
    commandOptions: {
      cwd: plan.context.executionCwd, scope: plan.options.scope, platform,
      yes: plan.options.yes,
      allowManagedCodexInstall: plan.options.allowManagedCodexInstall,
      scriptTimeoutMs: plan.options.scriptTimeoutMs,
      ...(plan.options.dependencyScopeOverrides ? { dependencyScopeOverrides: plan.options.dependencyScopeOverrides } : {}),
      ...(command === 'cleanup' ? { force: plan.options.force } : {}),
    },
    runtime: {
      ...runtime,
      ...(preview ? { nativeCliRunner: bindNativeCliRunnerSignal(
        runtime.nativeCliRunner ?? getDefaultNativeCliRunner(), runtime.signal) } : {}),
      env: plan.options.env,
      catalogOperationContext: plan.demand.catalogOperationContext,
      previewOperationPlan: preview,
      executionInput: {
        context: plan.context,
        requirements: command === 'cleanup' && (plan.demand.intent.state !== 'valid'
          || plan.demand.preferences.state === 'invalid' || plan.demand.preferences.state === 'unreadable')
          ? createEmptyNativeDemandView() : demandNativeProjection(plan.demand),
        selectedTargets: pluginIds.map((pluginId) => ({ pluginId, platform, scope: plan.options.scope })),
        preserveOtherObservedTargets: true,
      },
    },
  });
  if (preview) runtime.signal?.throwIfAborted();
  return result;
}

function nativeCleanupEvidence(
  result: RebuildCommandResult,
  pluginId: string,
  platform: PlatformName,
  scope: Scope,
): string[] {
  const actions = result.operationPlan?.actions.filter((action) =>
    action.pluginId === pluginId && action.platform === platform && action.scope === scope) ?? [];
  return [...new Set(actions.map((action) => action.kind))];
}

function nativeResults(plan: RecoveryPlan, group: NativeGroup,
  result: RebuildCommandResult, executed: boolean): void {
  for (const pluginId of group.pluginIds) {
    const platforms: PlatformName[] = [group.platform];
    for (const platform of platforms) {
      const agent = agentForPlatform(platform);
      const target = pair(plan, pluginId, agent)!;
      if (!target) continue;
      const backend = buildRebuildReceiptJson(group.command === 'install' ? 'sync' : group.command, result);
      target.backend = backend;
      target.recoveryActions = backend.recoveryActions;
      const backendTargets = result.targetResults.filter((entry) => entry.target.pluginId === pluginId
        && entry.target.platform === platform && entry.target.scope === plan.options.scope);
      const dependencies = result.dependencyPlan?.targets.filter((entry) =>
        entry.pluginId === pluginId || entry.requiredBy?.includes(pluginId)) ?? [];
      for (const failure of backendTargets.filter((entry) => entry.state === 'failed')) {
        block(target, failure.errorCode ?? 'nativeRecoveryFailed');
      }
      for (const dependency of dependencies.filter((entry) => entry.action === 'block')) {
        block(target, dependency.errorCode ?? 'dependencyNotReady');
      }
      if (executed) {
        const succeeded = backendTargets.length > 0 && backendTargets.every((entry) => entry.state === 'completed');
        target.execution = succeeded ? backendTargets.every((entry) => entry.action === 'skipped') ? 'no-op' : 'applied'
          : result.overallState === 'partial' ? 'partial' : 'failed';
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
    target.content = observations.some((entry) => entry.observation === 'conflict') ? 'conflict'
      : observations.some((entry) => entry.observation === 'unknown') ? 'unknown'
      : observations.some((entry) => entry.observation === 'drifted') ? 'drifted'
      : observations.some((entry) => entry.observation === 'absent') ? 'absent'
      : observations.length ? 'satisfied' : 'unknown';
    target.observation = target.content === 'satisfied' ? 'verified'
      : target.content === 'absent' ? 'missing' : 'unknown';
    for (const code of [...prepared.globalBlockers, ...observations.flatMap((entry) => entry.blocker ? [entry.blocker] : [])]) {
      block(target, code);
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
  target.execution = outcomes.length > 0 && outcomes.every((entry) => entry.execution === 'no-op') ? 'no-op'
    : outcomes.length > 0 && outcomes.every((entry) => ['applied', 'no-op'].includes(entry.execution)) ? 'applied'
    : outcomes.some((entry) => ['applied', 'no-op'].includes(entry.execution)) ? 'partial'
    : outcomes.some((entry) => entry.execution === 'failed') ? 'failed' : 'not-run';
  target.observation = outcomes.length > 0 && outcomes.every((entry) => entry.observation === 'satisfied')
    && globalBlockers.length === 0 ? 'verified'
    : globalBlockers.length === 0 && outcomes.some((entry) => entry.observation === 'absent'
      || entry.observation === 'drifted') && outcomes.every((entry) => entry.observation !== 'unknown'
      && entry.observation !== 'conflict') ? 'missing' : 'unknown';
  target.content = outcomes.some((entry) => entry.observation === 'conflict') ? 'conflict'
    : outcomes.some((entry) => entry.observation === 'unknown') ? 'unknown'
    : outcomes.some((entry) => entry.observation === 'drifted') ? 'drifted'
    : outcomes.some((entry) => entry.observation === 'absent') ? 'absent'
    : outcomes.length ? 'satisfied' : 'unknown';
  target.backend = outcomes.map((entry) => ({ skill: entry.skill, providerPluginId: entry.providerPluginId,
    requiredBy: portableRequiredBy(plan, prepared, entry), observation: entry.observation,
    ownership: entry.ownership, associatedAgents: entry.associatedAgents,
    execution: entry.execution, blockers: entry.blockers }));
  for (const code of [...globalBlockers, ...outcomes.flatMap((entry) => entry.blockers)]) block(target, code);
  target.recoveryActions = portableRecoveryActions(plan, target.pluginId,
    outcomes.filter((entry) => ['conflict', 'unknown'].includes(entry.observation)));
}

async function checkFootprints(plan: RecoveryPlan): Promise<void> {
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
      footprints.push({ path: await canonicalizePathThroughExistingAncestor(action.path),
        pluginIds: group.pluginIds.filter((id) => id === action.pluginId || consumers.includes(id)),
        agent: agentForPlatform(action.platform), identity: `native:${action.platform}:${action.pluginId}`,
        sharedNative: 'shared' in action && action.shared, nativeGroup });
    }
  }
  for (const prepared of plan.portableGroups) {
    for (const target of prepared.targets) footprints.push({
      path: await canonicalizePathThroughExistingAncestor(target.physicalPath),
      pluginIds: [prepared.options.selector], agent: target.agent,
      identity: `agent-skills:${prepared.logicalIdentity}:${target.providerPluginId}:${target.expectedDigest}`,
    });
  }
  for (let index = 0; index < footprints.length; index += 1) {
    const left = footprints[index]!;
    for (const right of footprints.slice(index + 1)) {
      if (left.path !== right.path || left.identity === right.identity
        || (left.nativeGroup !== undefined && left.nativeGroup === right.nativeGroup)
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
    if (prepared.options.agents.some((agent) => agent === 'codex' || agent === 'cursor')) {
      plan.warnings.push(`${prepared.options.selector}：.agents/skills 可能同时被 Codex、Cursor 等 Agent 读取。`);
    }
    const layout = portableRecoveryLayout(plan.context);
    plan.changes.push(plan.options.scope === 'user'
      ? `${prepared.options.selector}：使用 ${layout.generationRoot} 作为 Portable 来源；provider 可能更新所选 Agent 的全局 Skill 目录。读取全局 provider lock ${layout.lockPath} 仅用于观察。`
      : `${prepared.options.selector}：使用 ${layout.generationRoot} 作为 Portable 来源；provider 可能更新所选 Agent 的项目 Skill 目录和 ${layout.lockPath}。`);
  }
}

export async function prepareRecovery(command: RecoveryCommand, selectors: readonly string[],
  options: RecoveryOptions, runtime: RebuildCommandRuntime = {}): Promise<RecoveryPlan> {
  options.signal?.throwIfAborted();
  const context = await createScopeContext({ scope: options.scope, cwd: options.cwd, env: options.env });
  try {
  options.signal?.throwIfAborted();
  options = { ...options, cwd: context.executionCwd, env: context.env };
  let demand = await readDemand(options);
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
          options.signal?.throwIfAborted();
          if (error instanceof Error && error.name === 'AbortError') throw error;
          const code = errorCode(error, 'catalogGenerationRefreshFailed');
          refreshFailures.set(sourceId, code.startsWith('catalog') ? code : 'catalogGenerationRefreshFailed');
        }
      }
    }
  }
  options.signal?.throwIfAborted();
  const preparationRuntime = { ...runtime, signal: options.signal };
  const originalIntent = intentEvidence(demand.intent);
  const proposed = command === 'install'
    ? await addRequirements({ ...options, selectors, dryRun: true, installSelectors: true }) : undefined;
  if (proposed?.state && proposed.errors.length === 0) {
    const rawBytes = Buffer.from(JSON.stringify(proposed.state));
    demand = await readDemand({ ...options, intent: {
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
    nativeGroups: [], historicalNativeTargets: new Set(), deliverySwitchChecks: [], portableGroups: [],
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
    || receipt.blockers.some((entry) => !['localTargetsRequired'].includes(entry.code));
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
      const delivery = resolvedDelivery;
      receipt.targetResults.push({ pluginId, agent, scope: options.scope, delivery, execution: 'not-run', observation: 'unknown',
        blockers: [...(preciseCleanup ? [] : root?.blockers ?? []).map(diagnostic),
          ...(refreshFailures.has(parsePluginId(pluginId).sourceId!)
            ? [diagnostic(refreshFailures.get(parsePluginId(pluginId).sourceId!)!)] : []),
          ...((command === 'cleanup' || command === 'uninstall') && delivery?.kind === 'agent-skills'
            ? [diagnostic('backend-action-unsupported')] : []),
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
  if (command === 'cleanup' || command === 'uninstall') {
    for (const platform of ['codex', 'claude'] as const) {
      const candidates = receipt.targetResults.filter((target) => target.agent === agentForPlatform(platform));
      if (candidates.length === 0) continue;
      try {
        const preview = await nativeOperation(plan, candidates.map((target) => target.pluginId), platform,
          true, preparationRuntime, 'cleanup');
        for (const target of candidates) {
          if (target.delivery?.kind === 'native') continue;
          const cleanupEvidence = nativeCleanupEvidence(preview, target.pluginId, platform, options.scope);
          if (cleanupEvidence.length === 0) continue;
          target.delivery = { kind: 'native', platform };
          plan.historicalNativeTargets.add(`${target.pluginId}\0${platform}`);
          target.blockers = target.blockers.filter((entry) => entry.code !== 'backend-action-unsupported'
            && entry.code !== 'deliveryUnsupported');
        }
      } catch (error) {
        options.signal?.throwIfAborted();
        if (error instanceof Error && error.name === 'AbortError') throw error;
        for (const target of candidates.filter((entry) => entry.delivery?.kind === 'native')) {
          block(target, errorCode(error, 'nativePreparationFailed'));
        }
      }
    }
  }
  if (command !== 'cleanup' && command !== 'uninstall') {
    for (const platform of ['codex', 'claude'] as const) {
      const candidates = receipt.targetResults.filter((target) => target.blockers.length === 0
        && target.delivery?.kind === 'agent-skills' && target.agent === agentForPlatform(platform));
      if (candidates.length === 0) continue;
      try {
        const pluginIds = candidates.map((target) => target.pluginId);
        const preview = await nativeOperation(plan, pluginIds, platform, true, preparationRuntime, 'cleanup');
        const cleanPluginIds: string[] = [];
        for (const target of candidates) {
          const evidence = nativeCleanupEvidence(preview, target.pluginId, platform, options.scope);
          if (evidence.length === 0) {
            if (preview.overallState !== 'succeeded' || preview.warnings.length > 0
              || !preview.operationPlan) {
              block(target, 'deliverySwitchObservationFailed');
              target.recoveryActions = [`检查 ${target.pluginId}/${target.agent} 的 Native 现场后重试 aw sync。`];
            } else {
              cleanPluginIds.push(target.pluginId);
            }
            continue;
          }
          block(target, 'deliverySwitchCleanupRequired');
          target.backend = { previousDelivery: { kind: 'native', platform }, cleanupEvidence: evidence };
          target.recoveryActions = [
            `aw cleanup ${target.pluginId} --scope ${options.scope} --target ${target.agent}`,
            `aw sync ${target.pluginId} --scope ${options.scope} --target ${target.agent}`,
          ];
          plan.changes.push(`先清理 ${target.pluginId}/${target.agent} 的旧 Native 输出，再恢复 Portable。`);
        }
        if (cleanPluginIds.length && preview.operationPlan) plan.deliverySwitchChecks.push({
          pluginIds, cleanPluginIds, platform, fingerprint: preview.operationPlan.planFingerprint,
        });
      } catch (error) {
        options.signal?.throwIfAborted();
        if (error instanceof Error && error.name === 'AbortError') throw error;
        for (const target of candidates) {
          block(target, 'deliverySwitchObservationFailed');
          target.recoveryActions = [`检查 ${target.pluginId}/${target.agent} 的 Native 现场后重试 aw sync。`];
          plan.warnings.push(`${target.pluginId}/${target.agent}：${errorCode(error, 'deliverySwitchObservationFailed')}。`);
        }
      }
    }
  }
  const groups = new Map<string, { platform: PlatformName; command: RecoveryCommand; pluginIds: string[] }>();
  for (const target of receipt.targetResults) {
    if (target.blockers.length || target.delivery?.kind !== 'native') continue;
    const command = plan.historicalNativeTargets.has(`${target.pluginId}\0${target.delivery.platform}`)
      ? 'cleanup' : plan.command;
    const key = `${target.delivery.platform}\0${command}`;
    const group = groups.get(key) ?? { platform: target.delivery.platform, command, pluginIds: [] };
    group.pluginIds.push(target.pluginId);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.pluginIds.length === 0) continue;
    try {
      const preview = await nativeOperation(plan, group.pluginIds, group.platform, true, preparationRuntime, group.command);
      options.signal?.throwIfAborted();
      const nativeGroup = { ...group, preview };
      plan.nativeGroups.push(nativeGroup);
      nativeResults(plan, nativeGroup, preview, false);
      plan.changes.push(...(preview.operationPlan?.changes ?? []));
      for (const override of preview.dependencyPlan?.scopeOverrides ?? []) {
        if (options.dependencyScopeOverrides?.some((requested) => requested.pluginId === override.pluginId
          && (!requested.platform || requested.platform === override.platform))) {
          plan.changes.push(`本次依赖范围：${override.pluginId}#${override.platform}=${override.scope}。`);
        }
      }
      plan.warnings.push(...preview.warnings);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      for (const pluginId of group.pluginIds) block(pair(plan, pluginId, agentForPlatform(group.platform))!, errorCode(error, 'nativePreparationFailed'));
    }
  }
  if (command === 'install' && options.saveDependencyScopeOverrides
    && options.dependencyScopeOverrides?.length && !plan.blockExecution) {
    const requested = validateDependencyScopeOverrides(options.dependencyScopeOverrides, options.scope);
    const resolved = plan.nativeGroups.flatMap((group) => group.preview.dependencyPlan?.scopeOverrides ?? []);
    if (requested.some((entry) => !resolved.some((candidate) => candidate.pluginId === entry.pluginId
      && candidate.platform === entry.platform && candidate.scope === entry.scope))) {
      receipt.blockers.push(diagnostic('dependencyScopeOverrideInvalid'));
      plan.blockExecution = true;
    } else {
      const previous = demand.preferences.state === 'valid' ? demand.preferences.value : createEmptyPreferences();
      const overrides = validateDependencyScopeOverrides([
        ...previous.dependencyScopeOverrides.filter((entry) => !requested.some((candidate) =>
          candidate.pluginId === entry.pluginId && candidate.platform === entry.platform)), ...requested,
      ], options.scope);
      if (JSON.stringify(overrides) !== JSON.stringify(previous.dependencyScopeOverrides)) {
        plan.preferences = { ...previous, dependencyScopeOverrides: overrides };
        plan.plannedImpact.preferences = true;
        plan.changes.push(...requested.map((entry) =>
          `保存 ${options.scope} 依赖偏好：${entry.pluginId}#${entry.platform}=${entry.scope}。`));
      }
    }
  }
  for (const pluginId of receipt.requestedRoots) {
    const agents = receipt.targetResults.filter((target) => target.pluginId === pluginId
      && !target.blockers.length && target.delivery?.kind === 'agent-skills').map((target) => target.agent);
    if (!agents.length) continue;
    try {
      const prepared = await preparePortableRecovery({ scope: options.scope, context, selector: pluginId, agents,
        env: options.env, cliVersion: options.cliVersion, signal: options.signal,
        catalogOperationContext: demand.catalogOperationContext });
      plan.portableGroups.push(prepared);
    } catch (error) {
      if (error instanceof SkillsCliError && error.code === 'portableSkillsCliCleanupFailed') throw error;
      options.signal?.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      for (const agent of agents) block(pair(plan, pluginId, agent)!, errorCode(error, 'portablePreparationFailed'));
    }
  }
  for (const prepared of plan.portableGroups) portableResults(plan, prepared);
  if (command !== 'cleanup' && command !== 'uninstall') {
    // Complete scope demand protects copies contributed by unselected roots and their dependencies.
    const desiredAgents = new Set([...receipt.selection.agents,
      ...(demand.preferences.state === 'valid' ? demand.preferences.value.agents : [])]);
    const retainedPortableTargets: PortableTarget[] = [];
    for (const root of demand.roots ?? []) {
      const portableAgents = [...desiredAgents].filter((agent) => root.plugin
        && resolveDelivery(root.plugin.manifest, agent, options.scope)?.kind === 'agent-skills');
      if (!portableAgents.length) continue;
      try {
        const prepared = plan.portableGroups.find((group) => group.options.selector === root.pluginId
          && portableAgents.every((agent) => group.options.agents.includes(agent)))
          ?? await preparePortableRecovery({ scope: options.scope, context, selector: root.pluginId,
            env: options.env, agents: portableAgents, cliVersion: options.cliVersion, signal: options.signal,
            catalogOperationContext: demand.catalogOperationContext });
        if (!prepared.globalBlockers.length) {
          retainedPortableTargets.push(...prepared.targets.filter((target) =>
            !target.blocker && ['satisfied', 'drifted'].includes(target.observation)));
          if (!plan.portableGroups.includes(prepared)) plan.portableProtectionGroups.push(prepared);
        }
      } catch (error) {
        if (error instanceof SkillsCliError && error.code === 'portableSkillsCliCleanupFailed') throw error;
        options.signal?.throwIfAborted();
        if (error instanceof Error && error.name === 'AbortError') throw error;
        // Missing current Portable evidence cannot protect historical residue.
      }
    }
    for (const pluginId of receipt.requestedRoots) {
      const candidates = receipt.targetResults.filter((target) => target.pluginId === pluginId
        && target.blockers.length === 0 && target.delivery?.kind === 'native');
      if (candidates.length === 0) continue;
      const agents = candidates.map((target) => target.agent);
      const retainedTargets = retainedPortableTargets.filter((target) => target.providerPluginId === pluginId);
      let observation: PortableResidue;
      try {
        observation = await inspectPortableResidue({ scope: options.scope, context, selector: pluginId,
          env: options.env, agents, retainedTargets, signal: options.signal });
      } catch (error) {
        if (error instanceof SkillsCliError && error.code === 'portableSkillsCliCleanupFailed') throw error;
        options.signal?.throwIfAborted();
        if (error instanceof Error && error.name === 'AbortError') throw error;
        observation = { state: 'unknown', targets: [], blockers: ['portableObservationFailed'] };
      }
      plan.portableResidues.push({ kind: 'delivery-switch', pluginId, agents, observation, retainedTargets });
      if (observation.state === 'absent') continue;
      for (const target of candidates) {
        const residues = observation.targets.filter((entry) => entry.agent === target.agent);
        const uncertain = observation.unknownAgents?.includes(target.agent)
          ?? (observation.blockers.length > 0 && residues.length === 0);
        if (residues.length === 0 && !uncertain) continue;
        if (residues.length === 0) {
          block(target, 'deliverySwitchPortableObservationFailed');
          target.recoveryActions = [`检查 ${pluginId}/${target.agent} 的 Portable 输出和 provider 关联后重新准备。`];
        } else {
          block(target, 'deliverySwitchPortableCleanupRequired');
          target.backend = { previousDelivery: { kind: 'agent-skills', provider: 'skills-cli', agentId: target.agent },
            portableResidue: residues };
          target.recoveryActions = portableRecoveryActions(plan, pluginId, residues);
        }
      }
    }
  }
  for (const pluginId of command === 'cleanup' || command === 'uninstall' ? receipt.requestedRoots : []) {
    const agents = receipt.targetResults.filter((target) => target.pluginId === pluginId).map((target) => target.agent);
    const observation = await inspectPortableResidue({ scope: options.scope, context, selector: pluginId, env: options.env, agents, signal: options.signal });
    plan.portableResidues.push({ kind: 'cleanup', pluginId, agents, observation });
    if (observation.state !== 'absent') {
      plan.warnings.push(`${pluginId}：Portable 输出${observation.state === 'present' ? '仍存在' : '无法确认'}，本次操作不会删除它们。`);
      for (const target of receipt.targetResults.filter((entry) => entry.pluginId === pluginId)) {
        target.recoveryActions = [...(target.recoveryActions ?? []), ...portableRecoveryActions(plan, pluginId,
          observation.targets.filter((entry) => entry.agent === target.agent))];
      }
    }
  }
  options.signal?.throwIfAborted();
  await checkFootprints(plan);
  options.signal?.throwIfAborted();
  for (const prepared of [...plan.portableGroups, ...plan.portableProtectionGroups]) {
    delete prepared.options.signal;
  }
  plan.plannedImpact.outputs = !plan.blockExecution && (
    plan.nativeGroups.some((group) => (group.preview.operationPlan?.actions.length ?? 0) > 0
      && group.pluginIds.some((pluginId) => pair(plan, pluginId, agentForPlatform(group.platform))?.blockers.length === 0))
    || (command !== 'cleanup' && command !== 'uninstall' && plan.portableGroups.some((group) =>
      group.targets.some((target) => pair(plan, group.options.selector, target.agent)?.blockers.length === 0
        && (target.observation === 'absent' || target.observation === 'drifted'
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
    }, runtime);
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

export async function executeRecovery(plan: RecoveryPlan,
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
      const actualIntent = await observeIntent(plan.options);
      const current = await readDemand({ ...plan.options, ...(plan.declaration ? { intent: plan.demand.intent } : {}) });
      if (intentEvidence(actualIntent) !== plan.originalIntent || preferenceEvidence(current) !== plan.preferencesEvidence
        || current.catalogOperationContext?.generationSetDigest !== plan.demand.catalogOperationContext?.generationSetDigest) {
        receipt.blockers.push(diagnostic('operationReviewStale'));
        return completeReceipt(receipt);
      }
      const previewManager = plan.nativeGroups.map((group) => group.preview.codexManagerPreview)
        .find((entry) => entry?.state === 'system' || entry?.state === 'cached');
      const session = plan.nativeGroups.length ? await createCodexNativeObservationSession({
        exactCwd: plan.context.executionCwd, env: plan.context.env,
        runner: plan.runtime.nativeCliRunner ?? getDefaultNativeCliRunner(),
        manager: plan.runtime.codexManager ?? (previewManager?.state === 'system' || previewManager?.state === 'cached'
          ? previewManager.manager : undefined),
      }) : undefined;
      const nativeRuntime = { ...plan.runtime, awHomeMutationToken: token,
        ...(session ? { codexObservationSession: session } : {}) };
      try {
      // Freeze every backend before the first declaration or output write.
      for (const check of plan.deliverySwitchChecks) {
        const checked = await nativeOperation(plan, check.pluginIds, check.platform, true, nativeRuntime, 'cleanup')
          .catch(() => undefined);
        if (!checked || checked.overallState !== 'succeeded' || checked.warnings.length > 0
          || checked.operationPlan?.planFingerprint !== check.fingerprint
          || check.cleanPluginIds.some((pluginId) =>
            nativeCleanupEvidence(checked, pluginId, check.platform, plan.options.scope).length > 0)) {
          receipt.blockers.push(diagnostic('operationReviewStale'));
          return completeReceipt(receipt);
        }
      }
      for (const group of plan.nativeGroups) {
        if (group.pluginIds.every((id) => pair(plan, id, agentForPlatform(group.platform))!.blockers.length)) continue;
        const checked = await nativeOperation(plan, group.pluginIds, group.platform, true, nativeRuntime, group.command);
        if (checked.operationPlan?.planFingerprint !== group.preview.operationPlan?.planFingerprint) {
          receipt.blockers.push(diagnostic('operationReviewStale'));
          return completeReceipt(receipt);
        }
      }
      for (const prepared of plan.portableGroups) {
        if (prepared.options.agents.every((agent) => pair(plan, prepared.options.selector, agent)!.blockers.length)) continue;
        const checked = await inspectPortableRecovery(prepared.options);
        if (checked.evidenceDigest !== prepared.evidenceDigest) {
          receipt.blockers.push(diagnostic('operationReviewStale'));
          return completeReceipt(receipt);
        }
      }
      for (const prepared of plan.portableProtectionGroups) {
        const checked = await inspectPortableRecovery(prepared.options);
        if (checked.evidenceDigest !== prepared.evidenceDigest) {
          receipt.blockers.push(diagnostic('operationReviewStale'));
          return completeReceipt(receipt);
        }
      }
      for (const residue of plan.portableResidues) {
        const checked = await inspectPortableResidue({ scope: plan.options.scope, context: plan.context,
          selector: residue.pluginId, env: plan.options.env, agents: residue.agents,
          retainedTargets: residue.retainedTargets }).catch((error) => {
            if (error instanceof SkillsCliError && error.code === 'portableSkillsCliCleanupFailed') throw error;
            return undefined;
          });
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
      for (const group of plan.nativeGroups) {
        const executable = group.pluginIds.filter((id) => !pair(plan, id, agentForPlatform(group.platform))!.blockers.length);
        if (!executable.length) continue;
        try {
          const result = await nativeOperation(plan, executable, group.platform, false,
            { ...nativeRuntime,
              ...(executable.length === group.pluginIds.length && group.preview.operationPlan
                ? { expectedPlanFingerprint: group.preview.operationPlan.planFingerprint } : {}) }, group.command);
          receipt.outputsMayHaveChanged ||= result.rebuildResults.some((result) => result.actions.some((action) =>
            action.name === 'stale.cleanup' || action.name === 'native.write' || action.name === 'artifacts.write'
              || action.name === 'recovery.cleanup' || action.name === 'cleanup.owned'));
          nativeResults(plan, { ...group, pluginIds: executable }, result, true);
        } catch (error) {
          const code = errorCode(error, 'nativeRecoveryFailed');
          receipt.outputsMayHaveChanged ||= code !== 'preApplyAuthorizationRequired';
          for (const id of executable) { const target = pair(plan, id, agentForPlatform(group.platform))!;
            target.execution = 'failed'; block(target, code); }
        }
      }
      const completedFootprints: Array<{ physicalPath: string; expectedDigest: string; providerPluginId: string; logicalIdentity: string }> = [];
      const failedFootprints: Array<{ logicalIdentity: string; outcome: PortableExecutionTarget }> = [];
      for (const prepared of plan.portableGroups) {
        const agents = prepared.options.agents.filter((agent) => {
          if (pair(plan, prepared.options.selector, agent)!.blockers.length) return false;
          const outcomes: PortableExecutionTarget[] = prepared.targets.filter((entry) => entry.agent === agent).map((entry) => {
            const failed = failedFootprints.find((failure) => failure.logicalIdentity === prepared.logicalIdentity
              && failure.outcome.physicalPath === entry.physicalPath && failure.outcome.expectedDigest === entry.expectedDigest
              && failure.outcome.providerPluginId === entry.providerPluginId);
            return failed ? { ...failed.outcome, agent } : { ...entry, execution: 'not-run', blockers: [] };
          });
          if (!outcomes.some((entry) => entry.execution === 'failed')) return true;
          portableOutcomes(plan, prepared, agent, outcomes, []);
          return false;
        });
        if (!agents.length) continue;
        const result = await executePortableRecovery({ prepared, token, authorizeUpdate: plan.options.yes,
          action: plan.command === 'install' ? 'sync' : plan.command,
          targets: prepared.targets.filter((target) => agents.includes(target.agent)).map(({ skill, agent }) => ({ skill, agent })),
          completedFootprints });
        receipt.outputsMayHaveChanged ||= result.outputsMayHaveChanged;
        for (const agent of agents) {
          portableOutcomes(plan, prepared, agent, result.targets.filter((entry) => entry.agent === agent), result.globalBlockers);
        }
        failedFootprints.push(...result.targets.filter((target) => target.execution === 'failed')
          .map((outcome) => ({ logicalIdentity: prepared.logicalIdentity, outcome })));
        completedFootprints.push(...result.targets.filter((target) => target.observation === 'satisfied'
          && ['applied', 'no-op'].includes(target.execution) && target.blockers.length === 0)
          .map(({ physicalPath, expectedDigest, providerPluginId }) => ({ physicalPath, expectedDigest, providerPluginId,
            logicalIdentity: prepared.logicalIdentity })));
      }
      for (const { kind, pluginId, observation } of plan.portableResidues) {
        if (kind !== 'cleanup') continue;
        if (observation.state === 'absent') continue;
        const targets = receipt.targetResults.filter((target) => target.pluginId === pluginId
          && (observation.targets.some((entry) => entry.agent === target.agent)
            || (observation.unknownAgents?.includes(target.agent)
              ?? (observation.blockers.length > 0))));
        for (const target of targets) {
          block(target, observation.unknownAgents?.includes(target.agent)
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
      } finally { await session?.dispose(); }
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
