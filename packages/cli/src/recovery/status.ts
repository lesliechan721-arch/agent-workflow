import type { PlatformName, Scope } from '../types.js';
import { selectAgents, type AgentId } from '../intent/deployment-preferences.js';
import { createScopeContext, type ScopeContext } from '../intent/scope-context.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { statusCommandV8, flattenStatusTargets, statusTargetHasLiveConfigConsumer, type StatusScopedTarget } from '../commands/status-v6.js';
import { inspectPortableExtraInstalled, inspectPortableRecovery, portablePreparationDiagnostic } from '../portable/recovery.js';
import { readJointDemand, deriveJointDemand, findPlacementConflicts } from './joint-demand.js';
import { readDemand, resolveDelivery, type DemandSnapshot } from './demand.js';
import type { RecoveryDiagnostic, RecoveryReceipt, RecoveryTarget } from './receipt.js';
import type { CatalogOperationContext } from '../utils/catalog-operation-context.js';
import type { NativeCliRunner } from '../utils/native-cli.js';
import type { CodexNativeObservationSession } from '../utils/codex-native-observation.js';
import { analyzeCodexSurface } from '../utils/codex-surface-analysis.js';

export interface NativeObservation {
  pluginId: string;
  platform: PlatformName;
  content: NonNullable<RecoveryTarget['content']>;
  blockers: RecoveryDiagnostic[];
  assumedActivation?: boolean;
  backend?: unknown;
}
export interface RecoveryStatus {
  schemaVersion: 1;
  kind: 'aw-recovery-status';
  scope: Scope;
  ok: boolean;
  intent: { state: DemandSnapshot['intent']['state']; digest?: string };
  selection: { agents: AgentId[]; origin: 'argument' | 'preference' | 'none'; preferences: string };
  inventory: Array<{ pluginId: string; source: string; sourceState: string;
    blockers: RecoveryDiagnostic[]; targetResults: RecoveryTarget[] }> | null;
  observedTargets?: RecoveryTarget[];
  existingTargets?: Array<{ pluginId: string; agent: AgentId; scope: Scope }>;
  ownedTargets?: Array<{ pluginId: string; agent: AgentId; scope: Scope }>;
  extraObserved: Array<Omit<Pick<RecoveryTarget, 'pluginId' | 'agent' | 'scope' | 'delivery' | 'observation' | 'content' | 'backend'>, 'agent'>
    & { agent: AgentId | null }>;
  coverage: { native: boolean; portable: boolean; scopes?: Scope[]; projectRoot?: string };
  inSync: boolean | null;
  counts: { blocked: number; unconfirmed: number; pending: number; ready: number };
  allSatisfied: boolean | null;
  errors: RecoveryDiagnostic[];
}
export interface ReadRecoveryStatusOptions {
  nativeCliRunner?: NativeCliRunner;
  codexObservationSession?: CodexNativeObservationSession;
  catalogOperationContext?: CatalogOperationContext;
  scope?: Scope;
  context?: Scope;
  demandOverride?: DemandSnapshot;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cliVersion?: string;
  signal?: AbortSignal;
  targets?: readonly string[];
  nativeObservations?: NativeObservation[];
}

const NATIVE_READ_ERRORS = new Set(['nativeStateUnreadable', 'stateInventoryFailed', 'configReadFailed',
  'configInvalid', 'componentInspectionFailed', 'targetInspectionFailed', 'codexNativeObservationFailed',
  'nativeObservationFailed', 'nativeObservationUnavailable']);
function diagnostic(code: string): RecoveryDiagnostic { return { code, message: `目标尚未满足：${code}。` }; }
function safeNativePlacement(target: StatusScopedTarget): unknown {
  const component = ({ kind, key, state, metadata }: StatusScopedTarget['components'][number]) => ({
    kind, key, state,
    ...(metadata ? { metadata: Object.fromEntries(Object.entries(metadata).filter(([name]) =>
      ['enabled', 'scopes', 'relation', 'errorCode', 'shared', 'version', 'desiredVersion',
        'staleCacheObserved', 'effective', 'requiredMinVersion', 'detectedVersion', 'code',
        'kinds', 'platform', 'scope', 'project', 'rootIssueId', 'rootIssueCode'].includes(name))) } : {}),
  });
  const reason = ({ code, severity, dependencyPluginId, dependencyPlatform, dependencyScope,
    dependencyProject, rootIssueId, rootIssueCode }: StatusScopedTarget['reasons'][number]) => ({
    code, severity, dependencyPluginId, dependencyPlatform, dependencyScope, dependencyProject,
    rootIssueId, rootIssueCode,
  });
  return {
    pluginId: target.pluginId, platform: target.platform, scope: target.scope,
    state: target.state,
    components: target.components.map(component), reasons: target.reasons.map(reason),
    recoveryActions: target.recoveryActions.map(({ command, scope }) => ({ command, scope })),
    ...(target.sharedComponents ? { sharedComponents: target.sharedComponents.map(component) } : {}),
    ...(target.sharedReasons ? { sharedReasons: target.sharedReasons.map(reason) } : {}),
  };
}

export async function statusFromObservations(options: Omit<ReadRecoveryStatusOptions, 'context'> & {
  scope: Scope; demand: DemandSnapshot; context: ScopeContext; nativeObservations: NativeObservation[];
  extraObserved?: RecoveryStatus['extraObserved'];
  nativeReadErrors?: RecoveryDiagnostic[];
  portableCoverage?: boolean;
  portableInstalled?: Array<{ pluginId: string; agent: AgentId }>;
}): Promise<RecoveryStatus> {
  options.signal?.throwIfAborted();
  const { demand } = options;
  const errors: RecoveryDiagnostic[] = [...demand.errors, ...(options.nativeReadErrors ?? [])];
  let selection: RecoveryStatus['selection'];
  try { selection = selectAgents({ preferences: demand.preferences, targets: options.targets }); }
  catch {
    selection = { agents: [], origin: 'none', preferences: demand.preferences.state };
    errors.push(diagnostic('targetSelectionInvalid'));
  }
  const inventory: RecoveryStatus['inventory'] = demand.roots === null ? null : [];
  for (const root of demand.roots ?? []) {
    options.signal?.throwIfAborted();
    const blockers = root.blockers.map(diagnostic);
    if (!selection.agents.length) blockers.push(diagnostic('localTargetsRequired'));
    const targetResults: RecoveryTarget[] = [];
    for (const agent of selection.agents) {
      if (demand.targetRequirements && !demand.targetRequirements.some((item) => item.pluginId === root.pluginId && item.target === agent)) continue;
      options.signal?.throwIfAborted();
      const delivery = root.plugin ? resolveDelivery(root.plugin.manifest, agent, options.scope) ?? null : null;
      const target: RecoveryTarget = { pluginId: root.pluginId, agent, scope: options.scope, delivery,
        execution: 'not-run', observation: 'unknown', content: 'unknown', blockers: [...blockers],
        requiredBy: [root.pluginId], relation: 'root' };
      if (blockers.length) { targetResults.push(target); continue; }
      if (!delivery) target.blockers.push(diagnostic('deliveryUnsupported'));
      else if (delivery.kind === 'native') {
        const native = options.nativeObservations.find((entry) => entry.pluginId === root.pluginId
          && entry.platform === delivery.platform);
        if (native) {
          target.content = native.content;
          target.blockers.push(...native.blockers);
          errors.push(...native.blockers.filter((entry) => NATIVE_READ_ERRORS.has(entry.code))
            .map((entry) => ({ ...entry, pluginId: root.pluginId })));
          target.backend = { ...(native.assumedActivation ? { assumedActivation: true } : {}),
            ...(native.backend ? { live: safeNativePlacement(native.backend as StatusScopedTarget) } : {}) };
        } else {
          target.blockers.push(diagnostic('nativeObservationUnavailable'));
          errors.push({ ...diagnostic('nativeObservationUnavailable'), pluginId: root.pluginId });
        }
      } else {
        try {
          const portable = await inspectPortableRecovery({ scope: options.scope, context: options.context,
            selector: root.pluginId, agents: [agent as import('../portable/recovery-layout.js').PortableAgent], env: options.env, signal: options.signal,
            cliVersion: options.cliVersion ?? '0.0.0', catalogOperationContext: demand.catalogOperationContext,
            excludedPluginIds: demand.userProviders?.[agent] });
          options.signal?.throwIfAborted();
          target.blockers.push(...portable.blockers.map((code) => portablePreparationDiagnostic(portable, diagnostic(code),
            agent as import('../portable/recovery-layout.js').PortableAgent)));
          const observed = portable.targets.filter((entry) => entry.agent === agent);
          target.blockers.push(...observed.flatMap((entry) => entry.blocker ? [diagnostic(entry.blocker)] : []));
          target.content = (['conflict', 'drifted', 'absent', 'unknown'] as const)
            .find((state) => observed.some((entry) => entry.observation === state))
            ?? (observed.length && !portable.blockers.length ? 'satisfied' : 'unknown');
          if (observed.length === 0 && portable.blockers.includes('needs-preparation') && options.portableCoverage === true
            && options.portableInstalled && !options.portableInstalled.some((item) => item.pluginId === root.pluginId && item.agent === agent)) {
            target.content = 'absent'; target.blockers = target.blockers.filter((item) => item.code !== 'needs-preparation');
          }
          target.backend = observed.map((entry) => ({ skill: entry.skill, agent: entry.agent,
            ownership: entry.ownership, observation: entry.observation, associatedAgents: entry.associatedAgents }));
          if (target.blockers.some((entry) => /(?:VerificationFailed|ReadFailed|LockInvalid)/u.test(entry.code))) {
            errors.push({ ...diagnostic('portableObservationFailed'), pluginId: root.pluginId });
          }
        } catch (error) {
          options.signal?.throwIfAborted();
          if (error instanceof Error && error.name === 'AbortError') throw error;
          target.blockers.push(diagnostic('portableObservationFailed'));
          errors.push({ ...diagnostic('portableObservationFailed'), pluginId: root.pluginId });
        }
      }
      target.observation = target.content === 'satisfied' ? 'verified'
        : target.content === 'absent' ? 'missing' : 'unknown';
      targetResults.push(target);
    }
    inventory!.push({ pluginId: root.pluginId, source: root.sourceId, sourceState: root.sourceState,
      blockers, targetResults });
  }
  const counts = { blocked: 0, unconfirmed: 0, pending: 0, ready: 0 };
  let definiteFailure = false;
  let uncertain = inventory === null;
  for (const root of inventory ?? []) {
    const targets = root.targetResults;
    if (root.blockers.length || targets.some((target) => target.blockers.length || target.content === 'conflict'
      || target.delivery === null)) { counts.blocked++; }
    else if (!targets.length || targets.some((target) => target.content === 'unknown')) {
      counts.unconfirmed++; uncertain = true;
    } else if (targets.some((target) => target.content === 'absent' || target.content === 'drifted')) counts.pending++;
    else counts.ready++;
    if (!targets.length || root.blockers.some((entry) => !/^(?:pluginUnavailable|sourceMissing|sourceIdentityMismatch)$/u.test(entry.code))) {
      uncertain = true;
    }
    if (root.blockers.some((entry) => /^(?:pluginUnavailable|sourceMissing|sourceIdentityMismatch)$/u.test(entry.code))) {
      definiteFailure = true;
    }
    for (const target of targets) {
      if (target.content === 'absent' || target.content === 'drifted' || target.content === 'conflict'
        || target.blockers.some((entry) => entry.code === 'deliveryUnsupported')) {
        definiteFailure = true;
      } else if (target.content === 'unknown' || target.observation === 'unknown' || target.blockers.length) uncertain = true;
    }
  }
  const allSatisfied = definiteFailure ? false : uncertain ? null : true;
  options.signal?.throwIfAborted();
  return { schemaVersion: 1, kind: 'aw-recovery-status', scope: options.scope, ok: errors.length === 0,
    intent: { state: demand.intent.state, ...('digest' in demand.intent ? { digest: demand.intent.digest } : {}) },
    selection, inventory, extraObserved: options.extraObserved ?? [],
    coverage: { native: (options.nativeReadErrors?.length ?? 0) === 0, portable: options.portableCoverage ?? true },
    counts, allSatisfied, inSync: aggregateConvergence(allSatisfied, (options.extraObserved?.length ?? 0) > 0 ? 'present' : options.portableCoverage === false ? 'unknown' : 'absent'), errors };
}

export async function readScopedRecoveryStatus(options: ReadRecoveryStatusOptions & {
  scope: Scope;
  onDemand?: (demand: DemandSnapshot) => string[] | undefined;
  onNativeStatus?: (native: Awaited<ReturnType<typeof statusCommandV8>>,
    demand: DemandSnapshot) => void | Promise<void>;
}): Promise<RecoveryStatus> {
  options.signal?.throwIfAborted();
  const context = await createScopeContext({ scope: options.scope, cwd: options.cwd, env: options.env, readOnly: true });
  try {
    options.signal?.throwIfAborted();
    const demand = options.demandOverride ?? await readDemand({ scope: options.scope, cwd: context.executionCwd, env: context.env,
      catalogOperationContext: options.catalogOperationContext, signal: options.signal });
    options.signal?.throwIfAborted();
    const nativePlugins = options.onDemand?.(demand);
    const native = options.nativeObservations ? undefined : await statusCommandV8({
      cwd: context.executionCwd, env: context.env, scope: options.scope,
      ...(nativePlugins ? { plugins: nativePlugins } : {}),
      recoveryDemand: demand, recoverySelection: { targets: options.targets }, cliVersion: options.cliVersion,
      catalogOperationContext: options.catalogOperationContext,
      nativeCliRunner: options.nativeCliRunner,
      codexObservationSession: options.codexObservationSession,
      signal: options.signal,
    });
    options.signal?.throwIfAborted();
    if (native) await options.onNativeStatus?.(native, demand);
    options.signal?.throwIfAborted();
    const roots = new Set(demand.roots?.map((root) => root.pluginId) ?? []);
    const queue = [...(demand.roots ?? []).map((root) => root.plugin).filter((plugin) => plugin !== undefined)];
    const byId = new Map(demand.plugins.map((plugin) => [plugin.pluginId, plugin]));
    while (queue.length) {
      const plugin = queue.shift()!;
      for (const name of plugin.manifest.dependencies ?? []) {
        const id = `${plugin.sourceId}/${name}`;
        if (roots.has(id)) continue;
        roots.add(id);
        const dependency = byId.get(id);
        if (dependency) queue.push(dependency);
      }
    }
    const expected = (pluginId: string, agent: AgentId | null): boolean => demand.targetRequirements
      ? demand.targetRequirements.some((item) => item.pluginId === pluginId && item.target === agent)
      : roots.has(pluginId) && agent !== null && demand.preferences.state === 'valid' && demand.preferences.value.targets.includes(agent);
    // Native component lists can include a shared User activation marker. Only
    // a live scoped consumer or an actual scoped owner proves a cleanup target.
    const ownsScopedOutput = (target: StatusScopedTarget): boolean => statusTargetHasLiveConfigConsumer(target)
      || target.reasons.some((reason) => reason.code === 'removedPluginCleanupRequired')
      || native?.nativeExtraObserved.some((entry) => entry.pluginId === target.pluginId
        && entry.platform === target.platform && entry.scope === target.scope
        && entry.reference.kind === 'namespacedOwner') === true;
    const placed: RecoveryStatus['extraObserved'] = native ? flattenStatusTargets(native.payload.targets)
      .filter((target) => target.scope === options.scope && !expected(target.pluginId, target.platform)
        && ownsScopedOutput(target))
      .map((target) => ({ pluginId: target.pluginId, agent: target.platform === 'claude' ? 'claude' : 'codex',
        scope: options.scope, delivery: { kind: 'native', platform: target.platform },
        observation: target.state === 'ready' ? 'verified' : target.state === 'needsSync' ? 'missing' : 'unknown',
        content: target.state === 'ready' ? 'satisfied' : target.state === 'needsSync' ? 'drifted'
          : target.state === 'blocked' ? 'conflict' : 'unknown',
        backend: safeNativePlacement(target) })) : [];
    const owned: RecoveryStatus['extraObserved'] = native ? native.nativeExtraObserved
      .filter((entry) => entry.reference.kind !== 'namespacedConfig'
        && placed.some((target) => target.pluginId === entry.pluginId && target.agent === entry.platform)
        && !expected(entry.pluginId, entry.platform ?? null))
      .map((entry) => ({ pluginId: entry.pluginId, agent: entry.platform === 'claude' ? 'claude'
        : entry.platform === 'codex' ? 'codex' : null, scope: options.scope,
      delivery: entry.platform ? { kind: 'native', platform: entry.platform } : null,
      observation: 'unknown', content: 'unknown', backend: {
        kind: entry.reference.kind, pluginName: entry.reference.pluginName,
        sourceId: entry.reference.sourceId, platform: entry.reference.platform,
        scope: entry.reference.scope, marketplaceName: entry.reference.marketplaceName,
      } })) : [];
    const key = (entry: RecoveryStatus['extraObserved'][number]) =>
      `${entry.pluginId}\0${entry.agent ?? ''}\0${entry.scope}`;
    const placedKeys = new Set(placed.map(key));
    const nativeExtraObserved = [
      ...owned.filter((entry) => !placedKeys.has(key(entry))),
      ...placed.map((entry) => {
        const references = owned.filter((candidate) => key(candidate) === key(entry))
          .map((candidate) => candidate.backend);
        return references.length ? { ...entry, backend: { ...(entry.backend as object),
          ownerReferences: references } } : entry;
      }),
    ];
    const portableExtra = await inspectPortableExtraInstalled({
      scope: options.scope, context, env: context.env, signal: options.signal,
    });
    options.signal?.throwIfAborted();
    const portableObserved: RecoveryStatus['extraObserved'] = portableExtra.targets
      .filter((entry) => !expected(entry.pluginId, entry.agent))
      .map((entry) => ({ pluginId: entry.pluginId, agent: entry.agent, scope: options.scope,
        delivery: { kind: 'agent-skills', provider: 'aw', agentId: entry.agent },
        observation: entry.observation, content: entry.content,
        backend: { skill: entry.skill, logicalIdentity: entry.logicalIdentity } }));
    const extraObserved = [...nativeExtraObserved, ...portableObserved];
    const result = await statusFromObservations({ ...options, context, demand,
      nativeObservations: options.nativeObservations ?? native!.nativeObservations, extraObserved,
      portableCoverage: portableExtra.complete, portableInstalled: portableExtra.targets,
      nativeReadErrors: native?.payload.errors.filter((error) => NATIVE_READ_ERRORS.has(error.code))
        .map((error) => diagnostic(error.code)) });
    result.existingTargets = [
      ...(native ? flattenStatusTargets(native.payload.targets).filter((target) => target.scope === options.scope && statusTargetHasLiveConfigConsumer(target))
        .map((target) => ({ pluginId: target.pluginId, agent: target.platform, scope: target.scope })) : []),
      ...portableExtra.targets.map((target) => ({ pluginId: target.pluginId, agent: target.agent, scope: options.scope })),
    ];
    result.ownedTargets = [
      ...(native ? flattenStatusTargets(native.payload.targets).filter((target) => target.scope === options.scope && ownsScopedOutput(target))
        .map((target) => ({ pluginId: target.pluginId, agent: target.platform, scope: target.scope })) : []),
      ...portableExtra.targets.map((target) => ({ pluginId: target.pluginId, agent: target.agent, scope: options.scope })),
    ];
    return result;
  } finally { await context.dispose(); }
}

export async function checkRecovery(selectors: readonly string[], options: ReadRecoveryStatusOptions & { all?: boolean }): Promise<RecoveryReceipt> {
  const status = await readRecoveryStatus(options);
  const blockers: RecoveryDiagnostic[] = [];
  const roots = [...new Set(status.inventory?.map((root) => root.pluginId) ?? [])];
  const requested: string[] = [];
  if (options.all && selectors.length) blockers.push(diagnostic('syncSelectorConflict'));
  else if (!selectors.length) requested.push(...roots);
  else for (const selector of selectors) {
    const parsed = parsePluginId(selector);
    const matches = roots.filter((id) => parsed.sourceId ? id === selector : parsePluginId(id).pluginName === parsed.pluginName);
    if (matches.length !== 1) blockers.push(diagnostic('syncPluginNotDesired'));
    else if (!requested.includes(matches[0]!)) requested.push(matches[0]!);
  }
  const selectedRoots = status.inventory?.filter((root) => requested.includes(root.pluginId)) ?? [];
  blockers.push(...selectedRoots.flatMap((root) => root.blockers));
  if (requested.length && status.selection.agents.length === 0) blockers.push(diagnostic('targetsNotConfigured'));
  const targetResults = selectedRoots.flatMap((root) => root.targetResults)
    .filter((target) => !options.targets || options.targets.includes(target.agent));
  const remainingTargets = targetResults.filter((target) => target.blockers.length || target.observation !== 'verified')
    .map(({ pluginId, agent, scope, delivery }) => ({ pluginId, agent, scope, delivery }));
  if (status.intent.state !== 'valid' && status.intent.state !== 'absent') blockers.push(diagnostic('pluginIntentStateInvalid'));
  const errors = status.errors;
  const ok = blockers.length === 0 && remainingTargets.length === 0 && errors.length === 0
    && !(requested.length === 0 && status.allSatisfied === null);
  return { schemaVersion: 1, kind: 'aw-recovery', scope: status.scope, command: 'sync:check', ok,
    intent: { ...status.intent, roots: status.inventory === null ? null : roots },
    requestedRoots: requested, requestedTargets: targetResults.map(({ pluginId, agent, scope, delivery }) =>
      ({ pluginId, agent, scope, delivery })), selection: status.selection, blockers, errors,
    targetResults, remainingTargets, recoveryActions: ok ? [] : ['aw plugin status --json'],
    allSatisfied: status.allSatisfied, inSync: status.inSync,
    coverage: { scopes: status.coverage.scopes ?? [status.scope], ...(status.coverage.projectRoot ? { projectRoot: status.coverage.projectRoot } : {}) },
    declarationChanged: false, preferencesChanged: false, configChanged: false, outputsMayHaveChanged: false };
}

export function aggregateConvergence(allSatisfied: boolean | null, residue: 'present' | 'absent' | 'unknown'): boolean | null {
  return allSatisfied === false || residue === 'present' ? false
    : allSatisfied === null || residue === 'unknown' ? null : true;
}

export async function readRecoveryStatus(options: ReadRecoveryStatusOptions & {
  onDemand?: (demand: DemandSnapshot) => string[] | undefined;
  onNativeStatus?: (native: Awaited<ReturnType<typeof statusCommandV8>>, demand: DemandSnapshot) => void | Promise<void>;
}): Promise<RecoveryStatus> {
  const snapshot = await readJointDemand(options);
  const plan = deriveJointDemand(snapshot);
  const scopes = [snapshot.user, ...(snapshot.project ? [snapshot.project] : [])];
  const observed: RecoveryStatus[] = [];
  for (const demand of scopes) {
    const nodes = plan.placements.filter((item) => item.scope === demand.scope
      || demand.scope === 'project' && (item.target === 'codex' || item.target === 'claude')
        && item.contributions.some((contribution) => contribution.scope === 'project'));
    const expanded: DemandSnapshot = { ...demand,
      userProviders: demand.scope === 'project' ? Object.fromEntries((snapshot.preferences?.targets ?? []).map((target) => [target,
        plan.placements.filter((item) => item.scope === 'user' && item.target === target).map((item) => item.pluginId)])) : {},
      targetRequirements: nodes.map((item) => ({ pluginId: item.pluginId, target: item.target })), roots: demand.roots === null ? null : [...new Map(nodes.map((item) => [item.pluginId, {
      pluginId: item.pluginId, sourceId: item.plugin.sourceId!, sourceState: 'ready' as const,
      blockers: [], plugin: item.plugin,
    }])).values()] };
    observed.push(await readScopedRecoveryStatus({ ...options, scope: demand.scope,
      cwd: snapshot.context.projectRoot ?? options.cwd, targets: undefined, demandOverride: expanded }));
  }
  const allTargets = observed.flatMap((status) => status.inventory?.flatMap((item) => item.targetResults) ?? []);
  const inventory: RecoveryStatus['inventory'] = scopes.some((demand) => demand.roots !== null) ? [] : null;
  const visibleInventory: NonNullable<RecoveryStatus['inventory']> = [];
  for (const demand of scopes) for (const root of demand.roots ?? []) {
    const targetResults: RecoveryTarget[] = [];
    for (const requirement of plan.roots.filter((entry) => entry.scope === demand.scope && entry.pluginId === root.pluginId)) {
      const placement = plan.placements.find((item) => item.pluginId === root.pluginId && item.target === requirement.target);
      const target: RecoveryTarget = { pluginId: root.pluginId, agent: requirement.target, scope: demand.scope,
        requirementScope: demand.scope, providerScope: placement?.scope,
        delivery: root.plugin ? resolveDelivery(root.plugin.manifest, requirement.target, demand.scope) ?? null : null,
        execution: 'not-run', observation: 'unknown', content: 'unknown', requiredBy: [root.pluginId], relation: 'root', blockers: [...requirement.blockers] };
      if (requirement.state === 'excluded' || requirement.state === 'unsupported') {
        target.satisfaction = requirement.state; target.content = 'satisfied'; target.observation = 'verified';
        if (requirement.reasons?.length) target.reasons = requirement.reasons;
      } else if (requirement.state === 'required') {
        const providers = requirement.dependencies.map((id) => {
          const provider = plan.placements.find((item) => item.pluginId === id && item.target === requirement.target);
          const actual = allTargets.find((item) => item.pluginId === id && item.agent === requirement.target && item.scope === provider?.scope);
          if (demand.scope === 'project' && provider?.scope === 'user' && (requirement.target === 'codex' || requirement.target === 'claude')) {
            const activation = allTargets.find((item) => item.pluginId === id && item.agent === requirement.target && item.scope === 'project');
            if (actual?.content !== 'satisfied') return actual;
            if (requirement.target === 'codex' && activation && activation.blockers.length === 0) {
              const backend = activation.backend as { assumedActivation?: boolean; live?: StatusScopedTarget } | undefined;
              const surface = analyzeCodexSurface(provider.plugin.manifest);
              const completeUserCapability = surface.components.every((component) => !component.scopes.includes('project') || component.scopes.includes('user'));
              const effective = surface.nativeKinds.length === 0 || backend?.live?.components.some((component) =>
                component.kind === 'activation' && component.metadata?.effective === true);
              const supported = surface.nativeKinds.length === 0 || backend?.live?.sharedComponents?.some((component) =>
                component.kind === 'systemConsumer' && component.state === 'compatible');
              if (completeUserCapability && effective && supported && !backend?.assumedActivation) {
                return { ...activation, content: 'satisfied' as const, observation: 'verified' as const };
              }
            }
            return activation;
          }
          return actual;
        });
        target.blockers.push(...providers.flatMap((item) => item?.blockers ?? []));
        target.content = (['conflict', 'drifted', 'absent', 'unknown'] as const).find((state) => providers.some((item) => (item?.content ?? 'unknown') === state)) ?? 'satisfied';
        target.observation = target.content === 'satisfied' ? 'verified' : target.content === 'absent' ? 'missing' : 'unknown';
        target.satisfaction = target.content === 'satisfied' ? demand.scope === 'project' && placement?.scope === 'user' ? 'inherited-user' : 'installed'
          : target.content === 'unknown' ? 'unknown' : 'pending';
        target.backend = providers.map((provider) => ({ pluginId: provider?.pluginId, scope: provider?.scope, content: provider?.content, live: provider?.backend }));
      }
      targetResults.push(target);
    }
    visibleInventory.push({ pluginId: root.pluginId, source: root.sourceId, sourceState: root.sourceState,
      blockers: root.blockers.map(diagnostic), targetResults });
  }
  const expected = new Set(plan.placements.map((item) => `${item.pluginId}\0${item.target}\0${item.scope}`));
  const extraObserved = observed.flatMap((status) => status.extraObserved)
    .filter((item) => !expected.has(`${item.pluginId}\0${item.agent}\0${item.scope}`));
  const conflicts = findPlacementConflicts([...plan.placements,
    ...extraObserved.filter((item): item is typeof item & { agent: AgentId } => item.agent !== null)
      .map((item) => ({ pluginId: item.pluginId, target: item.agent, scope: item.scope }))]);
  const targets = visibleInventory.flatMap((item) => item.targetResults);
  const knownFailure = plan.errors.some((error) => ['targetsNotConfigured', 'dependencyExcluded', 'dependencyContractInvalid', 'targetPlacementConflict'].includes(error.code))
    || conflicts.length > 0 || targets.some((target) => ['absent', 'drifted', 'conflict'].includes(target.content ?? 'unknown'));
  const uncertain = !plan.complete || targets.some((target) => target.content === 'unknown' || target.blockers.length > 0);
  const allSatisfied = knownFailure ? false : uncertain ? null : true;
  const nativeCoverage = observed.every((status) => status.coverage.native);
  const portableCoverage = observed.every((status) => status.coverage.portable);
  const errors = [...plan.errors, ...conflicts, ...observed.flatMap((status) => status.errors)];
  return { schemaVersion: 1, kind: 'aw-recovery-status', scope: snapshot.context.context, ok: errors.length === 0,
    intent: { state: scopes.some((demand) => demand.intent.state === 'invalid') ? 'invalid'
      : scopes.some((demand) => demand.intent.state === 'unreadable') ? 'unreadable'
      : scopes.some((demand) => demand.intent.state === 'unsupported-version') ? 'unsupported-version'
      : scopes.some((demand) => demand.intent.state === 'valid') ? 'valid' : 'absent' },
    selection: { agents: snapshot.preferences?.targets ?? [], origin: snapshot.preferences?.targets.length ? 'preference' : 'none', preferences: snapshot.user.preferences.state },
    inventory: inventory === null ? null : visibleInventory, extraObserved, observedTargets: allTargets,
    existingTargets: observed.flatMap((status) => status.existingTargets ?? []), ownedTargets: observed.flatMap((status) => status.ownedTargets ?? []),
    coverage: { native: nativeCoverage, portable: portableCoverage, scopes: snapshot.context.scopes,
      ...(snapshot.context.projectRoot ? { projectRoot: snapshot.context.projectRoot } : {}) },
    counts: { blocked: targets.filter((target) => target.blockers.length).length,
      pending: targets.filter((target) => target.satisfaction === 'pending').length,
      unconfirmed: targets.filter((target) => target.content === 'unknown').length,
      ready: targets.filter((target) => target.content === 'satisfied').length },
    allSatisfied, inSync: aggregateConvergence(allSatisfied, extraObserved.length ? 'present' : nativeCoverage && portableCoverage ? 'absent' : 'unknown'), errors };
}
