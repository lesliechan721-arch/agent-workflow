import path from 'node:path';

import type { InstallCommandOptions, PlatformName } from '../types.js';
import type { CliPrompt } from '../commands/runtime.js';
import { runRebuildCommand, type RebuildCommandResult, type RebuildCommandRuntime } from '../commands/rebuild-command.js';
import { buildRebuildReceiptJson, portableCleanupMessages } from '../output/command-receipt.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { canonicalizePathThroughExistingAncestor, resolveCanonicalRepoProjectKey } from '../utils/state-paths.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { syncCatalogSourceGeneration } from '../utils/catalog-generation-service.js';
import {
  preparePortableProjectRecovery,
  inspectPortableProjectRecovery,
  inspectPortableProjectResidue,
  executePortableProjectRecovery,
  type PortableProjectPreparation,
  type PortableProjectExecutionTarget,
  type PortableProjectResidue,
  type PortableProjectTarget,
} from '../portable/project-recovery.js';
import { addProjectRequirements } from './project-commands.js';
import { readProjectDemand, projectDemandNativeProjection, resolveProjectDelivery, type ProjectDemand } from './project-demand.js';
import { createEmptyProjectPreferences, selectProjectAgents, writeProjectPreferences, type ProjectAgentId } from './project-preferences.js';
import { calculateProjectIntentDigest, observeProjectIntent } from './project-state.js';
import type { ProjectDiagnostic, ProjectRecoveryReceiptV1, ProjectTargetResult } from './project-types.js';
import { createRemovedProjectRequirements, type RemovedProjectRequirementsChanges } from './removed-requirements.js';
import { createEmptyPluginIntentState } from '../utils/plugin-intent-state.js';

export type ProjectRecoveryCommand = 'sync' | 'install' | 'reinstall' | 'uninstall' | 'cleanup';
export interface ProjectRecoveryOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cliVersion: string;
  targets?: readonly string[];
  platform?: string;
  all?: boolean;
  yes?: boolean;
  force?: boolean;
  refresh?: boolean;
  allowManagedCodexInstall?: boolean;
  scriptTimeoutMs?: number;
  interactive?: boolean;
  prompt?: CliPrompt;
  exactTargets?: readonly { pluginId: string; agent: ProjectAgentId }[];
  dependencyScopeOverrides?: InstallCommandOptions['dependencyScopeOverrides'];
}
interface NativeGroup {
  pluginIds: string[];
  platform: PlatformName;
  preview: RebuildCommandResult;
}
interface Footprint {
  path: string;
  pluginIds: string[];
  agent: ProjectAgentId;
  identity: string;
  sharedNative?: boolean;
}
export interface ProjectRecoveryPlan {
  command: ProjectRecoveryCommand;
  options: ProjectRecoveryOptions;
  receipt: ProjectRecoveryReceiptV1;
  changes: string[];
  warnings: string[];
  demand: ProjectDemand;
  originalIntent: string;
  preferencesEvidence: string;
  declaration?: string[];
  nativeGroups: NativeGroup[];
  portableGroups: PortableProjectPreparation[];
  runtime: RebuildCommandRuntime;
  removedChanges: RemovedProjectRequirementsChanges;
  removedPluginIds: string[];
  portableResidues: Array<{ pluginId: string; agents: ProjectAgentId[]; observation: PortableProjectResidue }>;
  blockExecution: boolean;
}

function diagnostic(code: string): ProjectDiagnostic {
  const messages: Record<string, string> = {
    localTargetsRequired: '项目已有需求，请先设置本机 Agent 或使用 --target。',
    deliveryUnsupported: '此插件没有适用于所选 Agent 的交付。',
    operationReviewStale: '确认依据已改变，请重新检查并确认。',
    syncPluginNotDesired: '所选插件尚未声明，请先运行 aw project add。',
    syncSelectionRequired: '请指定插件或使用 --all。',
    invalidExactTargets: '精确重试目标不属于当前请求，请重新检查并选择。',
    sourceRefreshFailed: '来源刷新失败，此来源的插件未恢复。',
    artifactCollision: '多个交付占用相同输出位置，请先处理冲突。',
    'backend-action-unsupported': '此后端尚不支持安全移除，请检查精确的 Portable 输出。',
  };
  return { code, message: messages[code] ?? `项目操作受阻：${code}。` };
}
function errorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9-]*$/u.test(code)) return code;
  const prefix = error instanceof Error ? error.message.split(':')[0] : '';
  return /^[A-Za-z][A-Za-z0-9-]*$/u.test(prefix ?? '') ? prefix! : fallback;
}
function intentEvidence(intent: ProjectDemand['intent']): string {
  return 'rawDigest' in intent ? `${intent.state}:${intent.rawDigest}` : intent.state;
}
function preferenceEvidence(demand: ProjectDemand): string {
  return 'rawDigest' in demand.preferences
    ? `${demand.preferences.state}:${demand.preferences.rawDigest}` : demand.preferences.state;
}
function agentForPlatform(platform: PlatformName): ProjectAgentId {
  return platform === 'claude' ? 'claude-code' : 'codex';
}
function pair(plan: ProjectRecoveryPlan, pluginId: string, agent: ProjectAgentId): ProjectTargetResult | undefined {
  return plan.receipt.targetResults.find((target) => target.pluginId === pluginId && target.agent === agent);
}
function block(target: ProjectTargetResult, code: string): void {
  if (!target.blockers.some((entry) => entry.code === code)) target.blockers.push(diagnostic(code));
}
function completeReceipt(receipt: ProjectRecoveryReceiptV1): ProjectRecoveryReceiptV1 {
  receipt.remainingTargets = receipt.targetResults.filter((target) => target.blockers.length > 0
    || !['applied', 'no-op'].includes(target.execution))
    .map(({ pluginId, agent }) => ({ pluginId, agent }));
  receipt.ok = receipt.blockers.length === 0 && receipt.remainingTargets.length === 0;
  receipt.recoveryActions = receipt.ok ? [] : [...new Set([
    ...receipt.blockers.map((entry) => entry.code === 'localTargetsRequired'
      ? 'aw project targets set <agent...>' : 'aw project status --json'),
    ...receipt.remainingTargets.flatMap((target) => {
      const result = receipt.targetResults.find((entry) => entry.pluginId === target.pluginId && entry.agent === target.agent);
      if (result?.recoveryActions?.length) return result.recoveryActions;
      return result?.blockers.some((entry) => entry.code === 'backend-action-unsupported' || entry.code === 'portableObservationFailed')
        ? `检查 ${target.pluginId} 的 Portable 输出及 provider 关联；AW 不支持安全自动删除。`
        : `aw sync ${target.pluginId} -s project --target ${target.agent}`;
    }),
  ])];
  return receipt;
}

function portableRecoveryActions(plan: ProjectRecoveryPlan, pluginId: string,
  targets: readonly (PortableProjectTarget | PortableProjectResidue['targets'][number])[]): string[] {
  return [...new Set(targets.map((target) => {
    const directory = path.relative(plan.options.cwd, target.physicalPath).split(path.sep).join('/');
    const shared = target.agent === 'codex' || target.agent === 'cursor'
      ? '该目录可能同时被 Codex 和 Cursor 读取；移开前请确认对两者的影响。' : `该目录供 ${target.agent} 使用。`;
    return `${pluginId}：请检查并备份项目目录 ${directory}；确认归属后可自行移开。${shared}`
      + (plan.command === 'cleanup' || plan.command === 'uninstall'
        ? 'AW 不自动删除此 Portable 目录；处理后重新检查项目状态。'
        : `然后重试 aw sync ${pluginId} -s project --target ${target.agent}。`);
  }))];
}

function selectRoots(demand: ProjectDemand, selectors: readonly string[], all: boolean): string[] {
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

async function nativeOperation(plan: ProjectRecoveryPlan, pluginIds: string[], platform: PlatformName,
  preview: boolean, runtime: RebuildCommandRuntime = plan.runtime): Promise<RebuildCommandResult> {
  return runRebuildCommand({
    command: plan.command === 'install' ? 'sync' : plan.command,
    pluginNames: pluginIds,
    commandOptions: {
      cwd: plan.options.cwd, scope: 'project', platform,
      yes: plan.options.yes,
      allowManagedCodexInstall: plan.options.allowManagedCodexInstall,
      scriptTimeoutMs: plan.options.scriptTimeoutMs,
      ...(plan.options.dependencyScopeOverrides ? { dependencyScopeOverrides: plan.options.dependencyScopeOverrides } : {}),
      ...(plan.command === 'cleanup' ? { force: plan.options.force } : {}),
    },
    runtime: {
      ...runtime,
      env: plan.options.env,
      catalogOperationContext: plan.demand.catalogOperationContext,
      previewOperationPlan: preview,
      removedProjectRequirements: runtime.removedProjectRequirements ?? createRemovedProjectRequirements({
        cwd: plan.options.cwd, env: plan.options.env, token: runtime.awHomeMutationToken, changes: plan.removedChanges,
      }),
      projectExecution: {
        requirements: plan.command === 'cleanup'
          ? ['valid', 'absent'].includes(plan.demand.intent.state)
            ? projectDemandNativeProjection({ ...plan.demand, preferences: { state: 'absent' } })
            : createEmptyPluginIntentState()
          : projectDemandNativeProjection(plan.demand),
        selectedTargets: pluginIds.map((pluginId) => ({ pluginId, platform, scope: 'project' })),
      },
    },
  });
}

function projectNativeResults(plan: ProjectRecoveryPlan, group: NativeGroup,
  result: RebuildCommandResult, executed: boolean): void {
  for (const pluginId of group.pluginIds) {
    const platforms: PlatformName[] = result.removedPluginCleanupIds?.includes(pluginId)
      ? ['codex', 'claude'] : [group.platform];
    for (const platform of platforms) {
      const agent = agentForPlatform(platform);
      const target = pair(plan, pluginId, agent)!;
      if (!target) continue;
      const backend = buildRebuildReceiptJson(plan.command === 'install' ? 'sync' : plan.command, result);
      target.backend = backend;
      target.recoveryActions = backend.recoveryActions;
      const backendTargets = result.targetResults.filter((entry) => entry.target.pluginId === pluginId
        && entry.target.platform === platform);
      const dependencies = result.dependencyPlan?.targets.filter((entry) =>
        entry.pluginId === pluginId || entry.requiredBy?.includes(pluginId)) ?? [];
      for (const failure of backendTargets.filter((entry) => entry.state === 'failed')) {
        block(target, failure.errorCode ?? 'nativeRecoveryFailed');
      }
      for (const dependency of dependencies.filter((entry) => entry.action === 'block')) {
        block(target, dependency.errorCode ?? 'dependencyNotReady');
      }
      if (executed) {
        const noCleanupWork = result.removedPluginCleanupIds?.includes(pluginId) && backendTargets.length === 0
          && result.targetResults.every((entry) => entry.target.pluginId !== pluginId || entry.state === 'completed');
        const succeeded = noCleanupWork || backendTargets.length > 0 && backendTargets.every((entry) => entry.state === 'completed');
        target.execution = succeeded ? noCleanupWork || backendTargets.every((entry) => entry.action === 'skipped') ? 'no-op' : 'applied'
          : result.overallState === 'partial' ? 'partial' : 'failed';
        target.observation = succeeded ? 'verified' : 'unknown';
        if (!succeeded && !target.blockers.length) block(target, 'nativeRecoveryFailed');
      }
    }
  }
  for (const residue of result.portableCleanupResidues ?? []) {
    const messages = portableCleanupMessages([residue]);
    if (!executed) plan.warnings.push(...messages.warnings);
    for (const target of plan.receipt.targetResults.filter((entry) => entry.pluginId === residue.pluginId)) {
      if (executed) {
        for (const code of [residue.state === 'present' ? 'backend-action-unsupported' : 'portableObservationFailed', ...residue.blockers]) {
          block(target, code);
        }
        if (target.execution === 'applied') target.execution = 'partial';
      }
      target.backend = { native: target.backend, portableRemaining: {
        state: residue.state, targets: residue.targets,
      } };
      target.recoveryActions = [...new Set([...(target.recoveryActions ?? []), ...messages.recoveryActions])];
    }
  }
}

function portableRequiredBy(plan: ProjectRecoveryPlan, prepared: PortableProjectPreparation,
  target: PortableProjectTarget): string[] {
  return plan.portableGroups.filter((group) => group.logicalIdentity === prepared.logicalIdentity
    && group.targets.some((entry) => entry.providerPluginId === target.providerPluginId
      && entry.expectedDigest === target.expectedDigest && entry.physicalPath === target.physicalPath))
    .map((group) => group.options.selector);
}

function projectPortableResults(plan: ProjectRecoveryPlan, prepared: PortableProjectPreparation): void {
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

function projectPortableOutcomes(plan: ProjectRecoveryPlan, prepared: PortableProjectPreparation,
  agent: ProjectAgentId, outcomes: PortableProjectExecutionTarget[], globalBlockers: string[]): void {
  const target = pair(plan, prepared.options.selector, agent)!;
  target.execution = outcomes.length > 0 && outcomes.every((entry) => entry.execution === 'no-op') ? 'no-op'
    : outcomes.length > 0 && outcomes.every((entry) => ['applied', 'no-op'].includes(entry.execution)) ? 'applied'
    : outcomes.some((entry) => ['applied', 'no-op'].includes(entry.execution)) ? 'partial'
    : outcomes.some((entry) => entry.execution === 'failed') ? 'failed' : 'not-run';
  target.observation = outcomes.length && outcomes.every((entry) => entry.observation === 'satisfied') ? 'verified' : 'unknown';
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

async function checkFootprints(plan: ProjectRecoveryPlan): Promise<void> {
  const footprints: Footprint[] = [];
  for (const group of plan.nativeGroups) {
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
        sharedNative: 'shared' in action && action.shared });
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
    plan.changes.push(`${prepared.options.selector}：准备 .agent-workflows/.local/portable 来源；provider 可能修改 skills-lock.json 和 Agent Skill 目录。`);
  }
}

export async function prepareProjectRecovery(command: ProjectRecoveryCommand, selectors: readonly string[],
  options: ProjectRecoveryOptions, runtime: RebuildCommandRuntime = {}): Promise<ProjectRecoveryPlan> {
  options = { ...options, cwd: await resolveCanonicalRepoProjectKey(options.cwd) };
  let demand = await readProjectDemand(options);
  const refreshFailures = new Map<string, string>();
  if (options.refresh && command === 'sync') {
    let selected: string[] = [];
    try { selected = selectRoots(demand, selectors, options.all ?? false); }
    catch { /* Selection below reports the invalid request without refreshing any source. */ }
    for (const sourceId of new Set(selected.map((id) => parsePluginId(id).sourceId!))) {
      try { await syncCatalogSourceGeneration({ sourceId, env: options.env,
        cwd: options.cwd, impactConfirmed: options.yes === true, cliVersion: options.cliVersion,
        runtime: runtime.catalogGenerationRuntime }); }
      catch (error) { refreshFailures.set(sourceId, errorCode(error, 'sourceRefreshFailed')); }
    }
    demand = await readProjectDemand(options);
  }
  const originalIntent = intentEvidence(demand.intent);
  const proposed = command === 'install'
    ? await addProjectRequirements({ ...options, selectors, dryRun: true, installSelectors: true }) : undefined;
  if (proposed?.state && proposed.errors.length === 0) {
    const rawBytes = Buffer.from(JSON.stringify(proposed.state));
    demand = await readProjectDemand({ ...options, intent: {
      state: 'valid', value: proposed.state, rawBytes,
      digest: calculateProjectIntentDigest(proposed.state), rawDigest: originalIntent,
    } });
  }
  const receipt: ProjectRecoveryReceiptV1 = {
    schemaVersion: 1, kind: 'aw-project-recovery', command, ok: false,
    intent: { state: demand.intent.state, ...('digest' in demand.intent ? { digest: demand.intent.digest } : {}),
      roots: demand.roots?.map((root) => root.pluginId) ?? null },
    requestedRoots: [], selection: { agents: [], origin: 'none' }, blockers: proposed?.errors ?? [],
    targetResults: [], remainingTargets: [], recoveryActions: [], declarationChanged: false,
    preferencesChanged: false, outputsMayHaveChanged: false,
  };
  const plan: ProjectRecoveryPlan = { command, options, receipt, demand, originalIntent,
    preferencesEvidence: preferenceEvidence(demand), changes: [], warnings: [],
    nativeGroups: [], portableGroups: [], runtime,
    removedChanges: { declarationChanged: false, preferencesChanged: false, configChanged: false }, removedPluginIds: [], portableResidues: [], blockExecution: false,
    ...(proposed?.state && proposed.errors.length === 0 ? { declaration: proposed.roots } : {}),
  };
  if (proposed?.changed) plan.changes.push(`保存共享项目需求：${proposed.roots.join('、')}。`);
  const preciseCleanup = command === 'cleanup' && selectors.length > 0
    && (options.targets !== undefined || options.platform !== undefined);
  try {
    receipt.selection = selectProjectAgents({ preferences: preciseCleanup ? { state: 'absent' } : demand.preferences,
      targets: options.targets, platform: options.platform });
    receipt.requestedRoots = command === 'cleanup' && selectors.length > 0 ? [...new Set(selectors.map((selector) => {
      const parsed = parsePluginId(selector);
      if (!parsed.sourceId) throw new Error('cleanupPluginIdRequired');
      return `${parsed.sourceId}/${parsed.pluginName}`;
    }))] : selectRoots(demand, selectors, options.all ?? false);
  } catch (error) { receipt.blockers.push(diagnostic(errorCode(error, 'projectSelectionInvalid'))); }
  if (options.exactTargets && (options.exactTargets.length === 0 || options.exactTargets.some((target) =>
    !receipt.requestedRoots.includes(target.pluginId) || !receipt.selection.agents.includes(target.agent)))) {
    receipt.blockers.push(diagnostic('invalidExactTargets'));
  }
  if (command === 'cleanup' && !options.force) {
    plan.removedPluginIds = receipt.requestedRoots.filter((id) => demand.roots?.some((root) =>
      root.pluginId === id && root.sourceState === 'ready' && root.blockers.includes('pluginUnavailable')));
  }
  if (!preciseCleanup) {
    if (!['valid', 'absent'].includes(demand.intent.state)) receipt.blockers.push(diagnostic('pluginIntentStateInvalid'));
  }
  if (receipt.requestedRoots.some((id) => !plan.removedPluginIds.includes(id)) && !receipt.selection.agents.length) receipt.blockers.push(diagnostic('localTargetsRequired'));
  if (!preciseCleanup) receipt.blockers.push(...demand.errors);
  plan.blockExecution = receipt.blockers.length > 0;
  for (const [sourceId, code] of refreshFailures) {
    receipt.blockers.push({ code, message: `${sourceId}：${diagnostic('sourceRefreshFailed').message}` });
  }
  for (const root of demand.roots ?? []) {
    if (!receipt.requestedRoots.includes(root.pluginId) || preciseCleanup || plan.removedPluginIds.includes(root.pluginId)) continue;
    receipt.blockers.push(...root.blockers.map((code) => ({ ...diagnostic(code), message: `${root.pluginId}：${diagnostic(code).message}` })));
  }
  for (const pluginId of receipt.requestedRoots) {
    const root = demand.roots?.find((entry) => entry.pluginId === pluginId);
    const agents = plan.removedPluginIds.includes(pluginId)
      ? [...new Set([...receipt.selection.agents, 'codex' as const, 'claude-code' as const])]
      : receipt.selection.agents;
    for (const agent of agents) {
      if (!plan.removedPluginIds.includes(pluginId) && options.exactTargets
        && !options.exactTargets.some((target) => target.pluginId === pluginId && target.agent === agent)) continue;
      const resolvedDelivery = root?.plugin ? resolveProjectDelivery(root.plugin.manifest, agent) ?? null : null;
      const delivery = (preciseCleanup && !resolvedDelivery || plan.removedPluginIds.includes(pluginId)) && agent !== 'cursor'
        ? { kind: 'native' as const, platform: agent === 'claude-code' ? 'claude' as const : 'codex' as const }
        : resolvedDelivery;
      receipt.targetResults.push({ pluginId, agent, delivery, execution: 'not-run', observation: 'unknown',
        blockers: [...(preciseCleanup || plan.removedPluginIds.includes(pluginId) ? [] : root?.blockers ?? []).map(diagnostic),
          ...(refreshFailures.has(parsePluginId(pluginId).sourceId!)
            ? [diagnostic(refreshFailures.get(parsePluginId(pluginId).sourceId!)!)] : []),
          ...((command === 'cleanup' || command === 'uninstall') && delivery?.kind === 'agent-skills'
            ? [diagnostic('backend-action-unsupported')] : []),
          ...(!delivery ? [diagnostic(preciseCleanup ? 'backend-action-unsupported' : 'deliveryUnsupported')] : [])],
        requiredBy: [pluginId] });
    }
  }
  if (plan.blockExecution) return { ...plan, receipt: completeReceipt(receipt) };
  const groups = new Map<string, { platform: PlatformName; pluginIds: string[] }>();
  for (const target of receipt.targetResults) {
    if (target.blockers.length || target.delivery?.kind !== 'native') continue;
    if (plan.removedPluginIds.includes(target.pluginId) && target.agent === 'claude-code') continue;
    const key = target.delivery.platform;
    const group = groups.get(key) ?? { platform: target.delivery.platform, pluginIds: [] };
    group.pluginIds.push(target.pluginId);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.platform === 'claude') group.pluginIds = group.pluginIds.filter((id) => !plan.removedPluginIds.includes(id));
    if (group.pluginIds.length === 0) continue;
    try {
      const preview = await nativeOperation(plan, group.pluginIds, group.platform, true);
      for (const pluginId of preview.removedPluginCleanupIds ?? []) {
        if (!plan.removedPluginIds.includes(pluginId)) plan.removedPluginIds.push(pluginId);
        for (const platform of ['codex', 'claude'] as const) {
          const agent = agentForPlatform(platform);
          if (!pair(plan, pluginId, agent)) receipt.targetResults.push({ pluginId, agent,
            delivery: { kind: 'native', platform }, execution: 'not-run', observation: 'unknown',
            blockers: [], requiredBy: [pluginId] });
        }
      }
      const nativeGroup = { ...group, preview };
      plan.nativeGroups.push(nativeGroup);
      projectNativeResults(plan, nativeGroup, preview, false);
      plan.changes.push(...(preview.operationPlan?.changes ?? []));
      for (const override of preview.dependencyPlan?.scopeOverrides ?? []) {
        if (options.dependencyScopeOverrides?.some((requested) => requested.pluginId === override.pluginId
          && (!requested.platform || requested.platform === override.platform))) {
          plan.changes.push(`保存本机依赖范围：${override.pluginId}#${override.platform}=${override.scope}。`);
        }
      }
      plan.warnings.push(...preview.warnings);
    } catch (error) {
      for (const pluginId of group.pluginIds) block(pair(plan, pluginId, agentForPlatform(group.platform))!, errorCode(error, 'nativePreparationFailed'));
    }
  }
  for (const pluginId of receipt.requestedRoots) {
    const agents = receipt.targetResults.filter((target) => target.pluginId === pluginId
      && !target.blockers.length && target.delivery?.kind === 'agent-skills').map((target) => target.agent);
    if (!agents.length) continue;
    try {
      const prepared = await preparePortableProjectRecovery({ selector: pluginId, agents,
        cwd: options.cwd, env: options.env, cliVersion: options.cliVersion,
        catalogOperationContext: demand.catalogOperationContext });
      plan.portableGroups.push(prepared);
    } catch (error) {
      for (const agent of agents) block(pair(plan, pluginId, agent)!, errorCode(error, 'portablePreparationFailed'));
    }
  }
  for (const prepared of plan.portableGroups) projectPortableResults(plan, prepared);
  for (const pluginId of command === 'cleanup' || command === 'uninstall' ? receipt.requestedRoots : []) {
    if (plan.removedPluginIds.includes(pluginId)) continue;
    const agents = receipt.targetResults.filter((target) => target.pluginId === pluginId).map((target) => target.agent);
    const observation = await inspectPortableProjectResidue({ selector: pluginId, cwd: options.cwd, env: options.env, agents });
    plan.portableResidues.push({ pluginId, agents, observation });
    if (observation.state !== 'absent') {
      plan.warnings.push(`${pluginId}：Portable 输出${observation.state === 'present' ? '仍存在' : '无法确认'}，本次操作不会删除它们。`);
      for (const target of receipt.targetResults.filter((entry) => entry.pluginId === pluginId)) {
        target.recoveryActions = [...(target.recoveryActions ?? []), ...portableRecoveryActions(plan, pluginId,
          observation.targets.filter((entry) => entry.agent === target.agent))];
      }
    }
  }
  await checkFootprints(plan);
  completeReceipt(receipt);
  return plan;
}

export async function executeProjectRecovery(plan: ProjectRecoveryPlan,
  execution: { yes?: boolean; runtime?: RebuildCommandRuntime } = {}): Promise<ProjectRecoveryReceiptV1> {
  const receipt = structuredClone(plan.receipt);
  plan = { ...plan, receipt, options: { ...plan.options, yes: execution.yes ?? plan.options.yes },
    runtime: { ...plan.runtime, ...execution.runtime } };
  return withAwHomeMutationLock({ env: plan.options.env, token: plan.runtime.awHomeMutationToken,
    action: async (token) => {
      const actualIntent = await observeProjectIntent(plan.options);
      const current = await readProjectDemand({ ...plan.options, ...(plan.declaration ? { intent: plan.demand.intent } : {}) });
      if (intentEvidence(actualIntent) !== plan.originalIntent || preferenceEvidence(current) !== plan.preferencesEvidence
        || current.catalogOperationContext?.generationSetDigest !== plan.demand.catalogOperationContext?.generationSetDigest) {
        receipt.blockers.push(diagnostic('operationReviewStale'));
        return completeReceipt(receipt);
      }
      // Freeze every backend before the first declaration or output write.
      for (const group of plan.nativeGroups) {
        if (group.pluginIds.every((id) => pair(plan, id, agentForPlatform(group.platform))!.blockers.length)) continue;
        const checked = await nativeOperation(plan, group.pluginIds, group.platform, true,
          { ...plan.runtime, awHomeMutationToken: token });
        if (checked.operationPlan?.planFingerprint !== group.preview.operationPlan?.planFingerprint) {
          receipt.blockers.push(diagnostic('operationReviewStale'));
          return completeReceipt(receipt);
        }
      }
      for (const prepared of plan.portableGroups) {
        if (prepared.options.agents.every((agent) => pair(plan, prepared.options.selector, agent)!.blockers.length)) continue;
        const checked = await inspectPortableProjectRecovery(prepared.options);
        if (checked.evidenceDigest !== prepared.evidenceDigest) {
          receipt.blockers.push(diagnostic('operationReviewStale'));
          return completeReceipt(receipt);
        }
      }
      for (const residue of plan.portableResidues) {
        const checked = await inspectPortableProjectResidue({ selector: residue.pluginId, cwd: plan.options.cwd,
          env: plan.options.env, agents: residue.agents });
        if (JSON.stringify(checked) !== JSON.stringify(residue.observation)) {
          receipt.blockers.push(diagnostic('operationReviewStale'));
          return completeReceipt(receipt);
        }
      }
      if (plan.declaration) {
        const declared = await addProjectRequirements({ ...plan.options, selectors: plan.declaration, token });
        receipt.declarationChanged = declared.changed;
        receipt.blockers.push(...declared.errors);
        plan.blockExecution ||= declared.errors.length > 0;
        const intent = await observeProjectIntent(plan.options);
        receipt.intent = { ...receipt.intent, state: intent.state, ...('digest' in intent ? { digest: intent.digest } : {}) };
      }
      if (plan.command === 'install' && plan.options.dependencyScopeOverrides?.length) {
        const applicable = plan.nativeGroups.flatMap((group) => group.preview.dependencyPlan?.scopeOverrides ?? [])
          .filter((override) => plan.options.dependencyScopeOverrides!.some((requested) =>
            requested.pluginId === override.pluginId && (!requested.platform || requested.platform === override.platform)));
        if (applicable.length) {
          const preferences = current.preferences.state === 'valid' ? current.preferences.value : createEmptyProjectPreferences();
          const overrides = new Map(preferences.dependencyScopeOverrides.map((override) => [`${override.pluginId}:${override.platform}`, override]));
          for (const override of applicable) overrides.set(`${override.pluginId}:${override.platform}`, override);
          try {
            const saved = await writeProjectPreferences({ ...plan.options, token }, { ...preferences, dependencyScopeOverrides: [...overrides.values()] });
            receipt.preferencesChanged ||= saved.changed;
          } catch {
            receipt.blockers.push(diagnostic('projectPreferencesWriteFailed'));
            return completeReceipt(receipt);
          }
        }
      }
      if (plan.blockExecution) return completeReceipt(receipt);
      for (const group of plan.nativeGroups) {
        const executable = group.pluginIds.filter((id) => !pair(plan, id, agentForPlatform(group.platform))!.blockers.length);
        if (!executable.length) continue;
        try {
          const result = await nativeOperation(plan, executable, group.platform, false,
            { ...plan.runtime, awHomeMutationToken: token,
              ...(executable.length === group.pluginIds.length && group.preview.operationPlan
                ? { expectedPlanFingerprint: group.preview.operationPlan.planFingerprint } : {}) });
          receipt.outputsMayHaveChanged ||= result.rebuildResults.some((result) => result.actions.length > 0);
          projectNativeResults(plan, { ...group, pluginIds: executable }, result, true);
        } catch (error) {
          receipt.outputsMayHaveChanged = true;
          for (const id of executable) { const target = pair(plan, id, agentForPlatform(group.platform))!;
            target.execution = 'failed'; block(target, errorCode(error, 'nativeRecoveryFailed')); }
        }
      }
      const completedFootprints: Array<{ physicalPath: string; expectedDigest: string; providerPluginId: string; logicalIdentity: string }> = [];
      const failedFootprints: Array<{ logicalIdentity: string; outcome: PortableProjectExecutionTarget }> = [];
      for (const prepared of plan.portableGroups) {
        const agents = prepared.options.agents.filter((agent) => {
          if (pair(plan, prepared.options.selector, agent)!.blockers.length) return false;
          const outcomes: PortableProjectExecutionTarget[] = prepared.targets.filter((entry) => entry.agent === agent).map((entry) => {
            const failed = failedFootprints.find((failure) => failure.logicalIdentity === prepared.logicalIdentity
              && failure.outcome.physicalPath === entry.physicalPath && failure.outcome.expectedDigest === entry.expectedDigest
              && failure.outcome.providerPluginId === entry.providerPluginId);
            return failed ? { ...failed.outcome, agent } : { ...entry, execution: 'not-run', blockers: [] };
          });
          if (!outcomes.some((entry) => entry.execution === 'failed')) return true;
          projectPortableOutcomes(plan, prepared, agent, outcomes, []);
          return false;
        });
        if (!agents.length) continue;
        const result = await executePortableProjectRecovery({ prepared, token, authorizeUpdate: plan.options.yes,
          action: plan.command === 'install' ? 'sync' : plan.command,
          targets: prepared.targets.filter((target) => agents.includes(target.agent)).map(({ skill, agent }) => ({ skill, agent })),
          completedFootprints });
        receipt.outputsMayHaveChanged ||= result.outputsMayHaveChanged;
        for (const agent of agents) {
          projectPortableOutcomes(plan, prepared, agent, result.targets.filter((entry) => entry.agent === agent), result.globalBlockers);
        }
        failedFootprints.push(...result.targets.filter((target) => target.execution === 'failed')
          .map((outcome) => ({ logicalIdentity: prepared.logicalIdentity, outcome })));
        completedFootprints.push(...result.targets.filter((target) => target.observation === 'satisfied'
          && ['applied', 'no-op'].includes(target.execution) && target.blockers.length === 0)
          .map(({ physicalPath, expectedDigest, providerPluginId }) => ({ physicalPath, expectedDigest, providerPluginId,
            logicalIdentity: prepared.logicalIdentity })));
      }
      receipt.declarationChanged ||= plan.removedChanges.declarationChanged;
      receipt.preferencesChanged ||= plan.removedChanges.preferencesChanged;
      for (const { pluginId, observation } of plan.portableResidues) {
        if (observation.state === 'absent') continue;
        const targets = receipt.targetResults.filter((target) => target.pluginId === pluginId
          && (observation.state === 'unknown' || observation.targets.some((entry) => entry.agent === target.agent)));
        for (const target of targets) {
          block(target, observation.state === 'present' ? 'backend-action-unsupported' : 'portableObservationFailed');
          if (target.execution === 'applied') target.execution = 'partial';
          target.backend = { ...(target.delivery?.kind === 'native' ? { native: target.backend } : { portable: target.backend }), portableRemaining: {
            state: observation.state, targets: observation.targets.map(({ skill, agent, physicalPath }) =>
              ({ skill, agent, projectPath: path.relative(plan.options.cwd, physicalPath).split(path.sep).join('/') })),
          } };
          target.recoveryActions = [...new Set([...(target.recoveryActions ?? []), ...portableRecoveryActions(plan, pluginId,
            observation.targets.filter((entry) => entry.agent === target.agent))])];
        }
      }
      if (receipt.declarationChanged) {
        const intent = await observeProjectIntent(plan.options);
        receipt.intent = { state: intent.state, ...('digest' in intent ? { digest: intent.digest } : {}),
          roots: intent.state === 'valid' ? intent.value.roots.map((root) => root.pluginId) : null };
      }
      return completeReceipt(receipt);
    } });
}

export async function runProjectRecovery(command: ProjectRecoveryCommand, selectors: readonly string[],
  options: ProjectRecoveryOptions, runtime: RebuildCommandRuntime = {}): Promise<ProjectRecoveryReceiptV1> {
  const plan = await prepareProjectRecovery(command, selectors, options, runtime);
  if (options.interactive && options.yes !== true && options.prompt?.confirm
    && (plan.declaration || plan.receipt.targetResults.some((target) => target.blockers.length === 0))) {
    const response = await options.prompt.confirm({ defaultValue: false, message: [
      `项目请求：${plan.receipt.requestedRoots.join('、')}；Agent：${plan.receipt.selection.agents.join('、') || '未选择'}。`,
      ...plan.receipt.targetResults.map((target) => `${target.pluginId} / ${target.agent}：${target.blockers.length
        ? `受阻（${target.blockers.map((entry) => entry.code).join('、')}）` : '可执行'}`),
      ...plan.changes, ...plan.warnings, ...plan.receipt.blockers.map((entry) => entry.message),
      '是否执行以上可处理变更及计划中的 preApply 脚本？',
    ].join('\n') });
    if (response.cancelled || response.value !== true) {
      plan.receipt.blockers.push(diagnostic('operationCancelled'));
      return completeReceipt(plan.receipt);
    }
    return executeProjectRecovery(plan, { yes: true, runtime: { preApplyConfirmed: true } });
  }
  return executeProjectRecovery(plan);
}
