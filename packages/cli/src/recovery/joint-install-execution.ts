import path from 'node:path';
import type { RebuildCommandRuntime } from '../commands/rebuild-command.js';
import type { CommandProducerResult, Scope } from '../types.js';
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
const packageKey = (pluginId: string, scope: Scope) => [pluginId, scope].join('\0');

interface InstallGroup {
  id: string;
  child?: RecoveryPlan;
  targets: RecoveryTarget[];
  dependencies: Set<string>;
  providerPositions: Map<RecoveryTarget, Position[]>;
  packages: NonNullable<RebuildCommandRuntime['configApplyPackages']>['targets'];
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
  const packageOwner = new Map<string, InstallGroup>();
  for (const entry of packages?.targets ?? []) {
    const native = groups.filter((group) => group.targets.some((target) =>
      target.agent !== 'generic' && target.pluginId === entry.pluginId));
    const owner = native.find((group) => group.child?.options.scope === entry.scope) ?? native[0] ?? addGroup([]);
    owner.packages.push(entry);
    packageOwner.set(packageKey(entry.pluginId, entry.scope), owner);
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
      for (const scope of new Set([target.scope, 'user'] as const)) requireGroup(group, packageOwner.get(packageKey(target.pluginId, scope)));
    }
    // A host's later scope validates the first scope's exact acknowledged effects.
    const first = group.targets[0];
    if (first?.scope === 'project' && first.agent !== 'generic') {
      requireGroup(group, groups.find((other) => other.targets.some((target) => target.agent === first.agent && target.scope === 'user')));
    }
    for (const entry of group.packages) for (const dependency of entry.dependencies) {
      if (group.child && first) {
        // The producer runs after this host's dependency preflight. Other hosts consuming
        // the same package wait for this producer and cannot be its prerequisites.
        requireGroup(group, targetGroup.get(positionKey({ pluginId: dependency, agent: first.agent, scope: first.scope }))
          ?? targetGroup.get(positionKey({ pluginId: dependency, agent: first.agent, scope: 'user' })));
      } else {
        for (const provider of groups) if (provider.targets.some((target) => target.pluginId === dependency)) requireGroup(group, provider);
      }
      requireGroup(group, packageOwner.get(packageKey(dependency, entry.scope)) ?? packageOwner.get(packageKey(dependency, 'user')));
    }
  }

  const stop = new AbortController();
  const signal = options.runtime.signal ? AbortSignal.any([options.runtime.signal, stop.signal]) : stop.signal;
  const admission = createInstallAdmission({ signal });
  const portableProgress: CheckedPortableProgress = { completed: [], failed: [] };
  const failed = new Set<string>();
  const packageFailures = new Set<string>();
  const producerResults = new Map<string, Promise<CommandProducerResult[]>>();
  const settledPackages = new Set<string>();
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
      const waitingForProducer = ([target.scope, 'user'] as const).some((scope) => {
        const key = packageKey(target.pluginId, scope);
        const owner = packageOwner.get(key);
        return owner && owner !== group && !settledPackages.has(key);
      });
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
  function applyPackage(pluginId: string, scope: Scope): Promise<CommandProducerResult[]> {
    const key = packageKey(pluginId, scope);
    let pending = producerResults.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => packages!.execute(pluginId, scope, token)).then((records) => {
        if (records.some((result) => result.state !== 'completed')) packageFailures.add(key);
        settledPackages.add(key);
        report();
        return records;
      });
      producerResults.set(key, pending);
    }
    return pending;
  }
  function blockPackage(pluginId: string, scope: Scope, code: string): CommandProducerResult[] {
    const key = packageKey(pluginId, scope);
    if (producerResults.has(key)) return [];
    const records = packages?.blocked?.(pluginId, scope, code) ?? [];
    packageFailures.add(key);
    producerResults.set(key, Promise.resolve(records));
    settledPackages.add(key);
    report();
    return records;
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
          if ([target.scope, 'user' as const].some((scope) => packageFailures.has(packageKey(target.pluginId, scope)))) {
            target.blockers.push({ code: 'commandPackageProviderNotSatisfied', message: '所需托管命令包未完成。' });
          }
        }
        const child = group.child;
        if (!child) {
          for (const entry of group.packages) {
            if (entry.dependencies.some((pluginId) => groups.some((provider) => provider.targets.some((target) =>
              target.pluginId === pluginId && failed.has(positionKey(target))) || provider.packages.some((item) =>
              item.pluginId === pluginId && packageFailures.has(packageKey(item.pluginId, item.scope)))))) {
              blockPackage(entry.pluginId, entry.scope, 'dependencyApplyFailed');
            } else {
              try {
                const awHome = children[0]?.context.awHome;
                await admission.run(awHome ? [{ kind: 'path', value: path.join(awHome, 'commands') }] : [{ kind: 'exclusive' }],
                  () => applyPackage(entry.pluginId, entry.scope));
              } catch (error) {
                if (recoveryInterruptionCode(error) === 'processCleanupUnconfirmed') throw error;
                signal.throwIfAborted();
                if (error instanceof Error && error.name === 'AbortError' || readSafeOperationError(error)) throw error;
                const key = packageKey(entry.pluginId, entry.scope);
                producerResults.delete(key);
                blockPackage(entry.pluginId, entry.scope, 'commandPackageApplyFailed');
              }
            }
            if (packageFailures.has(packageKey(entry.pluginId, entry.scope))) {
              blockers.set(group.id, { code: 'commandPackageProviderNotSatisfied', message: entry.pluginId });
            }
          }
          return;
        }
        const generic = group.targets[0]!.agent === 'generic';
        const childRuntime: RebuildCommandRuntime = { ...runtime, batchInstallPlatform: child.runtime.batchInstallPlatform };
        if (group.packages.length) childRuntime.nativeTargetExecution = {
          async beforeApply(identity) {
            const results: CommandProducerResult[] = [];
            for (const entry of group.packages.filter((item) => item.pluginId === identity.pluginId
              && (item.scope === 'user' || item.scope === identity.scope))) results.push(...await applyPackage(entry.pluginId, entry.scope));
            return results;
          },
          blocked: (identity, code) => group.packages.filter((item) => item.pluginId === identity.pluginId
            && (item.scope === 'user' || item.scope === identity.scope)).flatMap((item) =>
              blockPackage(item.pluginId, item.scope, code === 'dependencyInstallFailed' ? 'dependencyApplyFailed' : code)),
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
  const commands: CommandProducerResult[] = [];
  for (const entry of packages?.targets ?? []) {
    const result = producerResults.get(packageKey(entry.pluginId, entry.scope));
    if (!result) continue;
    try { commands.push(...await result); }
    catch (error) { if (!interruption) throw error; }
  }
  return { receipts: groups.flatMap((group) => receipts.get(group) ?? []), commands,
    blockers: groups.flatMap((group) => blockers.get(group.id) ?? []), interruption };
}
