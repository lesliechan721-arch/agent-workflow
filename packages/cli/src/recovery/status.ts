import type { PlatformName, Scope } from '../types.js';
import { selectAgents, type AgentId } from '../intent/deployment-preferences.js';
import { createScopeContext, type ScopeContext } from '../intent/scope-context.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { statusCommandV8, flattenStatusTargets, type StatusScopedTarget } from '../commands/status-v6.js';
import { inspectPortableExtraInstalled, inspectPortableRecovery } from '../portable/recovery.js';
import { SkillsCliError } from '../portable/skills-cli.js';
import { readDemand, resolveDelivery, type DemandSnapshot } from './demand.js';
import type { RecoveryDiagnostic, RecoveryReceipt, RecoveryTarget } from './receipt.js';
import type { CatalogOperationContext } from '../utils/catalog-operation-context.js';

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
  extraObserved: Array<Omit<Pick<RecoveryTarget, 'pluginId' | 'agent' | 'scope' | 'delivery' | 'observation' | 'content' | 'backend'>, 'agent'>
    & { agent: AgentId | null }>;
  coverage: { native: boolean; portable: boolean };
  counts: { blocked: number; unconfirmed: number; pending: number; ready: number };
  allSatisfied: boolean | null;
  errors: RecoveryDiagnostic[];
}
export interface ReadRecoveryStatusOptions {
  catalogOperationContext?: CatalogOperationContext;
  scope: Scope;
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

export async function statusFromObservations(options: ReadRecoveryStatusOptions & {
  demand: DemandSnapshot; context: ScopeContext; nativeObservations: NativeObservation[];
  extraObserved?: RecoveryStatus['extraObserved'];
  nativeReadErrors?: RecoveryDiagnostic[];
  portableCoverage?: boolean;
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
            selector: root.pluginId, agents: [agent], env: options.env, signal: options.signal,
            cliVersion: options.cliVersion ?? '0.0.0', catalogOperationContext: demand.catalogOperationContext });
          options.signal?.throwIfAborted();
          target.blockers.push(...portable.blockers.map(diagnostic));
          const observed = portable.targets.filter((entry) => entry.agent === agent);
          target.blockers.push(...observed.flatMap((entry) => entry.blocker ? [diagnostic(entry.blocker)] : []));
          target.content = (['conflict', 'drifted', 'absent', 'unknown'] as const)
            .find((state) => observed.some((entry) => entry.observation === state))
            ?? (observed.length && !portable.blockers.length ? 'satisfied' : 'unknown');
          target.backend = observed.map((entry) => ({ skill: entry.skill, agent: entry.agent,
            ownership: entry.ownership, observation: entry.observation, associatedAgents: entry.associatedAgents }));
          if (target.blockers.some((entry) => /(?:VerificationFailed|ReadFailed|LockInvalid)/u.test(entry.code))) {
            errors.push({ ...diagnostic('portableObservationFailed'), pluginId: root.pluginId });
          }
        } catch (error) {
          if (error instanceof SkillsCliError && error.code === 'portableSkillsCliCleanupFailed') throw error;
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
    coverage: { native: true, portable: options.portableCoverage ?? true },
    counts, allSatisfied, errors };
}

export async function readRecoveryStatus(options: ReadRecoveryStatusOptions & {
  onDemand?: (demand: DemandSnapshot) => string[] | undefined;
  onNativeStatus?: (native: Awaited<ReturnType<typeof statusCommandV8>>,
    demand: DemandSnapshot) => void | Promise<void>;
}): Promise<RecoveryStatus> {
  options.signal?.throwIfAborted();
  const context = await createScopeContext({ scope: options.scope, cwd: options.cwd, env: options.env, readOnly: true });
  try {
    options.signal?.throwIfAborted();
    const demand = await readDemand({ scope: options.scope, cwd: context.executionCwd, env: context.env,
      catalogOperationContext: options.catalogOperationContext, signal: options.signal });
    options.signal?.throwIfAborted();
    const nativePlugins = options.onDemand?.(demand);
    const native = options.nativeObservations ? undefined : await statusCommandV8({
      cwd: context.executionCwd, env: context.env, scope: options.scope,
      ...(nativePlugins ? { plugins: nativePlugins } : {}),
      recoveryDemand: demand, recoverySelection: { targets: options.targets }, cliVersion: options.cliVersion,
      catalogOperationContext: options.catalogOperationContext,
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
    const placed: RecoveryStatus['extraObserved'] = native ? flattenStatusTargets(native.payload.targets)
      .filter((target) => target.scope === options.scope && !roots.has(target.pluginId)
        && target.state !== 'absent')
      .map((target) => ({ pluginId: target.pluginId, agent: target.platform === 'claude' ? 'claude-code' : 'codex',
        scope: options.scope, delivery: { kind: 'native', platform: target.platform },
        observation: target.state === 'ready' ? 'verified' : target.state === 'needsSync' ? 'missing' : 'unknown',
        content: target.state === 'ready' ? 'satisfied' : target.state === 'needsSync' ? 'drifted'
          : target.state === 'blocked' ? 'conflict' : 'unknown',
        backend: safeNativePlacement(target) })) : [];
    const owned: RecoveryStatus['extraObserved'] = native ? native.nativeExtraObserved
      .filter((entry) => !roots.has(entry.pluginId))
      .map((entry) => ({ pluginId: entry.pluginId, agent: entry.platform === 'claude' ? 'claude-code'
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
      .filter((entry) => !roots.has(entry.pluginId))
      .map((entry) => ({ pluginId: entry.pluginId, agent: entry.agent, scope: options.scope,
        delivery: { kind: 'agent-skills', provider: 'skills-cli', agentId: entry.agent },
        observation: entry.observation, content: entry.content,
        backend: { skill: entry.skill } }));
    const extraObserved = [...nativeExtraObserved, ...portableObserved];
    return await statusFromObservations({ ...options, context, demand,
      nativeObservations: options.nativeObservations ?? native!.nativeObservations, extraObserved,
      portableCoverage: portableExtra.complete,
      nativeReadErrors: native?.payload.errors.filter((error) => NATIVE_READ_ERRORS.has(error.code))
        .map((error) => diagnostic(error.code)) });
  } finally { await context.dispose(); }
}

export async function checkRecovery(selectors: readonly string[], options: ReadRecoveryStatusOptions & { all?: boolean }): Promise<RecoveryReceipt> {
  const blockers: RecoveryDiagnostic[] = [];
  let requested: string[] = [];
  const relevant = new Set<string>();
  const status = await readRecoveryStatus({ ...options, onDemand: (demand) => {
    const roots = demand.roots?.map((root) => root.pluginId) ?? [];
    if (options.all && selectors.length) blockers.push(diagnostic('syncSelectorConflict'));
    else if (options.all) requested = roots;
    else if (!selectors.length && roots.length) blockers.push(diagnostic('syncSelectionRequired'));
    else for (const selector of selectors) {
      const parsed = parsePluginId(selector);
      const matches = roots.filter((id) => parsed.sourceId ? id === selector : parsePluginId(id).pluginName === parsed.pluginName);
      if (matches.length !== 1) blockers.push(diagnostic('syncPluginNotDesired'));
      else if (!requested.includes(matches[0]!)) requested.push(matches[0]!);
    }
    const plugins = new Map(demand.plugins.map((plugin) => [plugin.pluginId, plugin]));
    const queue = [...requested];
    for (const id of requested) relevant.add(id);
    while (queue.length) {
      const pluginId = queue.shift()!;
      const plugin = plugins.get(pluginId);
      if (!plugin) continue;
      for (const name of plugin.manifest.dependencies ?? []) {
        const dependencyId = `${plugin.sourceId}/${name}`;
        if (relevant.has(dependencyId)) continue;
        relevant.add(dependencyId);
        queue.push(dependencyId);
      }
    }
    return options.all ? undefined : [...relevant];
  } });
  const selectedRoots = status.inventory?.filter((root) => requested.includes(root.pluginId)) ?? [];
  const errors = status.errors.filter((error) => !error.pluginId || relevant.has(error.pluginId));
  blockers.push(...selectedRoots.flatMap((root) => root.blockers));
  const targetResults = selectedRoots.flatMap((root) => root.targetResults);
  const remainingTargets = targetResults.filter((target) => target.blockers.length || target.observation !== 'verified')
    .map(({ pluginId, agent, scope, delivery }) => ({ pluginId, agent, scope, delivery }));
  if (status.intent.state !== 'valid' && status.intent.state !== 'absent') blockers.push(diagnostic('pluginIntentStateInvalid'));
  const ok = blockers.length === 0 && remainingTargets.length === 0 && errors.length === 0
    && !(requested.length === 0 && status.allSatisfied === null);
  return { schemaVersion: 1, kind: 'aw-recovery', scope: options.scope, command: 'sync:check', ok,
    intent: { ...status.intent, roots: status.inventory?.map((root) => root.pluginId) ?? null },
    requestedRoots: requested, requestedTargets: targetResults.map(({ pluginId, agent, scope, delivery }) =>
      ({ pluginId, agent, scope, delivery })), selection: status.selection, blockers, errors,
    targetResults, remainingTargets, recoveryActions: ok ? [] : [`aw status --scope ${options.scope} --json`],
    declarationChanged: false, preferencesChanged: false, configChanged: false, outputsMayHaveChanged: false };
}
