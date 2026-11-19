import path from 'node:path';
import type { RebuildCommandRuntime } from '../commands/rebuild-command.js';
import type { CommandProducerResult } from '../types.js';
import type { AwHomeMutationToken } from '../utils/aw-home-mutation-lock.js';
import { readSafeOperationError } from '../utils/safe-operation-diagnostic.js';
import { executeCheckedScopedInstall, type CheckedPortableProgress, type RecoveryPlan } from './coordinator.js';
import { createInstallAdmission, runInstallTasks, type InstallTask } from './install-concurrency.js';
import { RecoveryInterruptedError, recoveryInterruptionCode } from './interruption.js';
import { rebaseCheckedProjectInstall } from './joint-install-native-rebase.js';
import type { JointDemandPlan } from './joint-demand.js';
import { measureRecoveryPerformanceStage } from './performance.js';
import type { RecoveryDiagnostic, RecoveryReceipt, RecoveryTarget } from './receipt.js';

type Position = Pick<RecoveryTarget, 'pluginId' | 'agent' | 'scope'>;
const positionKey = ({ pluginId, agent, scope }: Position) => [pluginId, agent, scope].join('\0');
type PackageTarget = NonNullable<RebuildCommandRuntime['configApplyPackages']>['targets'][number];
function consumesPackage(target: Position, entry: PackageTarget): boolean {
  return target.pluginId === entry.pluginId && target.agent !== 'generic' && entry.platforms.includes(target.agent)
    && (target.scope === entry.scope || entry.scope === 'user');
}

interface InstallGroup {
  id: string;
  child?: RecoveryPlan;
  targets: RecoveryTarget[];
  dependencies: Set<string>;
  providerPositions: Map<RecoveryTarget, Position[]>;
  packages: PackageTarget[];
}

export async function executeJointInstall(options: {
  children: RecoveryPlan[];
  demand: JointDemandPlan;
  runtime: RebuildCommandRuntime;
  token: AwHomeMutationToken;
  yes?: boolean;
  existingOnly?: boolean;
}): Promise<{ receipts: RecoveryReceipt[]; commands: CommandProducerResult[]; blockers: RecoveryDiagnostic[]; interruption?: unknown }> {
  const { children, demand, token } = options;
  const groups: InstallGroup[] = [];
  const targetGroup = new Map<string, InstallGroup>();
  const addGroup = (targets: RecoveryTarget[], child?: RecoveryPlan) => {
    const group: InstallGroup = { id: String(groups.length), targets, child, dependencies: new Set(), providerPositions: new Map(), packages: [] };
    groups.push(group);
    for (const target of targets) targetGroup.set(positionKey(target), group);
    return group;
  };
  for (const child of children) {
    const targets = child.receipt.targetResults;
    if (targets[0]?.agent === 'generic') {
      for (const target of targets) addGroup([target], child);
    } else if (targets.length) addGroup(targets, child);
  }

  const packages = options.runtime.configApplyPackages;
  const entries = packages?.targets ?? [];
  const packageOwner = new Map<PackageTarget, InstallGroup>();
  const providerPositions = new Map<PackageTarget, Position[]>();
  const providerPackages = new Map<PackageTarget, PackageTarget[]>();
  for (const entry of entries) {
    const consumers = groups.filter((group) => group.targets.some((target) => consumesPackage(target, entry)));
    const owner = consumers.find((group) => group.targets.some((target) => consumesPackage(target, entry) && target.scope === entry.scope))
      ?? consumers[0] ?? addGroup([]);
    owner.packages.push(entry);
    packageOwner.set(entry, owner);
  }
  function requireGroup(group: InstallGroup, provider?: InstallGroup): void {
    if (provider && provider !== group) group.dependencies.add(provider.id);
  }
  for (const group of groups) {
    for (const target of group.targets) {
      const placement = demand.placements.find((item) => item.target === target.agent
        && item.pluginId === target.pluginId && item.scope === target.scope)
        ?? demand.placements.find((item) => item.target === target.agent && item.pluginId === target.pluginId && item.scope === 'user');
      const providers: Position[] = [];
      for (const name of placement?.plugin.manifest.dependencies ?? []) {
        const pluginId = `${placement!.plugin.sourceId}/${name}`;
        const candidates = demand.placements.filter((item) => item.target === target.agent && item.pluginId === pluginId);
        const provider = candidates.find((item) => item.scope === target.scope) ?? candidates.find((item) => item.scope === 'user');
        if (provider) providers.push({ pluginId, agent: provider.target, scope: provider.scope });
      }
      if (group.child?.options.nativeActivationOnlyTargets?.some((item) => item.pluginId === target.pluginId
        && item.platform === target.agent && item.scope === target.scope)) providers.push({ ...target, scope: 'user' });
      for (const provider of providers) requireGroup(group, targetGroup.get(positionKey(provider)));
      group.providerPositions.set(target, providers);
      for (const entry of entries) if (consumesPackage(target, entry)) requireGroup(group, packageOwner.get(entry));
    }
    // A host's later scope validates the first scope's exact acknowledged effects.
    const first = group.targets[0];
    if (first?.scope === 'project' && first.agent !== 'generic') {
      requireGroup(group, groups.find((other) => other.targets.some((target) => target.agent === first.agent && target.scope === 'user')));
    }
    for (const entry of group.packages) {
      const positions: Position[] = [];
      // A native consumer has already preflighted its own host's dependencies.
      // An independent package sees only its declared hosts in its render scope.
      const platforms = first && first.agent !== 'generic' ? [first.agent] : entry.platforms;
      for (const pluginId of entry.dependencies) for (const agent of platforms) {
        const position: Position = { pluginId, agent, scope: first?.scope ?? entry.scope };
        if (!targetGroup.has(positionKey(position))) position.scope = 'user';
        const provider = targetGroup.get(positionKey(position));
        if (provider) {
          positions.push(position);
          requireGroup(group, provider);
        }
      }
      const dependencies = entries.filter((item) => entry.dependencies.includes(item.pluginId)
        && (item.scope === entry.scope || item.scope === 'user') && platforms.some((agent) => item.platforms.includes(agent)));
      for (const item of dependencies) requireGroup(group, packageOwner.get(item));
      providerPackages.set(entry, dependencies);
      providerPositions.set(entry, positions);
    }
  }

  const stop = new AbortController();
  const signal = options.runtime.signal ? AbortSignal.any([options.runtime.signal, stop.signal]) : stop.signal;
  const admission = createInstallAdmission({ signal });
  const portableProgress: CheckedPortableProgress = { completed: [], failed: [] };
  const failed = new Set<string>();
  const produced = new Map<PackageTarget, CommandProducerResult[]>();
  const pending = new Map<PackageTarget, Promise<CommandProducerResult[]>>();
  const packageFailed = (entry: PackageTarget) => produced.get(entry)?.some((result) => result.state !== 'completed');
  const blockers = new Map<string, RecoveryDiagnostic>();
  const states = new Map<string, { target: RecoveryTarget; group: InstallGroup; value: 'waiting' | 'running' | 'completed' }>();
  for (const group of groups) for (const target of group.targets) {
    states.set(positionKey(target), { target, group, value: 'waiting' });
  }
  const report = () => {
    if (!options.runtime.onInstallProgress) return;
    let running = 0;
    let completed = 0;
    let waitingForDependencies = 0;
    for (const state of states.values()) {
      if (state.value === 'running') { running++; continue; }
      if (state.value === 'completed') { completed++; continue; }
      const { group, target } = state;
      const waitingForProvider = group.providerPositions.get(target)?.some((position) => {
        const provider = states.get(positionKey(position));
        return provider && provider !== state && provider.value !== 'completed';
      });
      const waitingForProducer = entries.some((entry) => consumesPackage(target, entry)
        && packageOwner.get(entry) !== group && !produced.has(entry));
      if (waitingForProvider || waitingForProducer) waitingForDependencies++;
    }
    try { options.runtime.onInstallProgress({ running, completed, waitingForDependencies,
      waiting: states.size - running - completed - waitingForDependencies }); }
    catch { /* A progress display cannot change the outcome. */ }
  };
  const state = (target: Position, value: 'running' | 'completed') => {
    const previous = states.get(positionKey(target));
    if (previous && previous.value !== value) { previous.value = value; report(); }
  };
  const runtime: RebuildCommandRuntime = { ...options.runtime, signal, installAdmission: admission,
    onInstallTargetState: (identity, value) => {
      if (identity.pluginId) state({ pluginId: identity.pluginId, agent: identity.platform, scope: identity.scope }, value);
    } };
  function blockPackage(entry: PackageTarget, code: string): CommandProducerResult[] {
    const previous = produced.get(entry);
    if (previous) return previous;
    const records = packages!.blocked(entry.pluginId, entry.scope, code, entry.packageId);
    produced.set(entry, records);
    report();
    return records;
  }
  function applyPackage(entry: PackageTarget): Promise<CommandProducerResult[]> {
    const completed = produced.get(entry);
    if (completed) return Promise.resolve(completed);
    const previous = pending.get(entry);
    if (previous) return previous;
    const execute = async () => {
      if (providerPositions.get(entry)?.some((item) => failed.has(positionKey(item)))
        || providerPackages.get(entry)?.some(packageFailed)) return blockPackage(entry, 'dependencyApplyFailed');
      try {
        const records = await packages!.execute(entry.pluginId, entry.scope, token, entry.packageId);
        if (!records.length) return blockPackage(entry, 'commandPackageApplyFailed');
        produced.set(entry, records);
        report();
        return records;
      } catch (error) {
        const code = recoveryInterruptionCode(error, signal);
        const records = blockPackage(entry, code ?? readSafeOperationError(error)?.code ?? 'commandPackageApplyFailed');
        if (code) {
          stop.abort(error);
          throw error;
        }
        return records;
      }
    };
    const result = execute();
    pending.set(entry, result);
    return result;
  }
  async function applyStandalone(entry: PackageTarget): Promise<void> {
    const awHome = children[0]?.context.awHome;
    await admission.run(awHome ? [{ kind: 'path', value: path.join(awHome, 'commands') }] : [{ kind: 'exclusive' }],
      () => applyPackage(entry));
  }
  const receipts = new Map<InstallGroup, RecoveryReceipt>();
  const tasks: InstallTask<void>[] = groups.map((group) => ({
    id: group.id, dependencies: [...group.dependencies], resources: [],
    run: async () => {
      try {
        for (const target of group.targets) {
          const provider = group.providerPositions.get(target)?.find((item) => failed.has(positionKey(item)));
          if (provider) target.blockers.push({ code: provider.scope === 'user' && target.scope === 'project'
            ? 'userProviderNotSatisfied' : 'dependencyApplyFailed',
            message: `依赖提供者未完成。恢复后重试 aw plugin sync ${target.pluginId} --context ${target.scope} --target ${target.agent} --yes` });
          if (entries.some((entry) => consumesPackage(target, entry) && packageFailed(entry))) {
            target.blockers.push({ code: 'commandPackageProviderNotSatisfied', message: '所需托管命令包未完成。' });
          }
        }
        const child = group.child;
        if (!child) {
          for (const entry of group.packages) {
            await applyStandalone(entry);
            if (packageFailed(entry)) {
              blockers.set(group.id, { code: 'commandPackageProviderNotSatisfied', message: entry.pluginId });
            }
          }
          return;
        }
        const generic = group.targets[0]!.agent === 'generic';
        const childRuntime: RebuildCommandRuntime = { ...runtime, batchInstallPlatform: child.runtime.batchInstallPlatform };
        const ownedPackages = (identity: { pluginId?: string; platform: Position['agent']; scope: Position['scope'] }) =>
          group.packages.filter((entry) => consumesPackage({ pluginId: identity.pluginId ?? '', agent: identity.platform, scope: identity.scope }, entry));
        if (group.packages.length) childRuntime.nativeTargetExecution = {
          produces: (identity) => ownedPackages(identity).length > 0,
          async beforeApply(identity) {
            const results: CommandProducerResult[] = [];
            for (const entry of ownedPackages(identity)) results.push(...await applyPackage(entry));
            return results;
          },
          blocked: (identity, code) => ownedPackages(identity).flatMap((entry) =>
            blockPackage(entry, code === 'dependencyInstallFailed' ? 'dependencyApplyFailed' : code)),
        };
        const checked = await rebaseCheckedProjectInstall(child, receipts.values(), childRuntime);
        const receipt = await measureRecoveryPerformanceStage(runtime, 'recovery.child.execute', () =>
          executeCheckedScopedInstall(checked, { runtime: childRuntime, yes: options.yes, portableProgress,
            ...(generic ? { pluginIds: group.targets.map((target) => target.pluginId) } : {}) }));
        receipts.set(group, receipt);
        for (const target of receipt.targetResults) {
          if (options.existingOnly && target.blockers.some((error) => error.code === 'dependencyInstallFailed')) {
            for (const error of target.blockers) if (error.code === 'dependencyInstallFailed') error.code = 'dependencyApplyFailed';
            if (target.execution === 'failed') target.execution = 'not-run';
          }
          if (target.blockers.length || !['applied', 'no-op'].includes(target.execution)) failed.add(positionKey(target));
          state(target, 'completed');
        }
        // A child may skip its native callback (preflight failure or a healthy wider provider).
        for (const entry of group.packages) if (!produced.has(entry)) {
          const owner = receipt.targetResults.find((target) => consumesPackage(target, entry));
          const blocker = owner?.blockers[0] ?? receipt.blockers[0];
          if (owner && !blocker && !failed.has(positionKey(owner))) await applyStandalone(entry);
          else blockPackage(entry, blocker?.code ?? 'commandPackageProviderNotSatisfied');
        }
      } catch (error) {
        if (error instanceof RecoveryInterruptedError) receipts.set(group, error.receipt);
        stop.abort(error);
        throw error;
      }
    },
  }));
  report();
  let interruption: unknown;
  try {
    await runInstallTasks(tasks, { signal, admission: null });
  } catch (error) {
    const code = recoveryInterruptionCode(error, options.runtime.signal);
    if (!code) throw error;
    interruption = error;
    for (const group of groups) {
      if (!group.child || receipts.has(group)) continue;
      const receipt = structuredClone(group.child.receipt);
      receipt.ok = false;
      receipt.errors = [ { code, message: code } ];
      receipt.targetResults = structuredClone(group.targets);
      for (const target of receipt.targetResults) {
        const running = states.get(positionKey(target))?.value === 'running';
        target.execution = running ? 'partial' : 'not-run';
        target.observation = 'unknown';
        if (running) target.content = 'unknown';
        target.blockers.push({ code, message: code });
        receipt.outputsMayHaveChanged ||= running;
      }
      receipt.remainingTargets = receipt.targetResults.map(({ pluginId, scope, agent, delivery }) => ({ pluginId, scope, agent, delivery }));
      receipt.recoveryActions = receipt.remainingTargets.map((item) =>
        `aw plugin sync ${item.pluginId} --context ${item.scope} --target ${item.agent}`);
      receipts.set(group, receipt);
    }
  }
  const commands = entries.flatMap((entry) => produced.get(entry)
    ?? blockPackage(entry, recoveryInterruptionCode(interruption, signal) ?? 'commandPackageProviderNotSatisfied'));
  return { receipts: groups.flatMap((group) => receipts.get(group) ?? []), commands,
    blockers: groups.flatMap((group) => blockers.get(group.id) ?? []), interruption };
}
