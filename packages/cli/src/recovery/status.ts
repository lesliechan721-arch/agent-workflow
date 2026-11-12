import path from 'node:path';
import { isPlatformTarget, normalizeStaticPluginComponents, type PluginComponent } from '@lesliechan721/aw-plugin-core/manifest';
import type { PlatformName, Scope } from '../types.js';
import { selectAgents, type AgentId } from '../intent/deployment-preferences.js';
import { createScopeContext, type ScopeContext } from '../intent/scope-context.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import type { StatusScopedTarget } from '../commands/status-v6.js';
import { inspectPortableExtraInstalled, inspectPortableRecovery, portablePreparationDiagnostic } from '../portable/recovery.js';
import { readJointDemand, deriveJointDemand, type JointDemandSnapshot } from './joint-demand.js';
import { readDemand, resolveDelivery, type DemandSnapshot } from './demand.js';
import type { RecoveryDiagnostic, RecoveryReceipt, RecoveryTarget } from './receipt.js';
import type { CatalogOperationContext } from '../utils/catalog-operation-context.js';
import { runNativeCli, type NativeCliRunner } from '../utils/native-cli.js';
import { rethrowFatalError } from '../utils/codex-executable-discovery.js';
import { createCodexNativeObservationSession, type CodexNativeObservationSession } from '../utils/codex-native-observation.js';
import { analyzeCodexSurface } from '../utils/codex-surface-analysis.js';
import { getAgentPluginAdapter } from '../platforms/registry.js';
import { getQualifiedPlatformProfile } from '../platforms/capabilities.js';
import { resolveArtifactRenderConfig } from '../utils/artifact-renderer.js';
import { createPlatformInputEvidence, matchesPlatformEmptyState, platformPackageInputDigest, readPlatformPackageContentDigest } from '../utils/platform-empty-state.js';
import { getDeploymentLayout } from '../platforms/layout.js';
import { deploymentPackageComponent, inspectStaticSupplements } from '../platforms/inspection.js';
import { readSkillOwnerMarker } from '../utils/ownership.js';
import { inventoryCatalogSourceReferences } from '../utils/catalog-source-references.js';
import { resolvePartialCatalogOperationContext } from '../utils/catalog-operation-context.js';
import { checkAwCapabilitySupport, readPluginManifest } from '../utils/manifest.js';
import { IMPLEMENTED_AW_CAPABILITIES } from '../commands/aw-capabilities.js';
import { resolvePluginMetaDependencyClosure } from '../utils/plugin-dependencies.js';
import { installationInvocation, type ReadContext } from '../platforms/discovery.js';
import { DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS } from '../constants.js';

export interface NativeObservation {
  pluginId: string;
  expectedVersion?: string;
  installedVersion?: string;
  platform: PlatformName;
  content: NonNullable<RecoveryTarget['content']>;
  blockers: RecoveryDiagnostic[];
  assumedActivation?: boolean;
  backend?: unknown;
  deploymentObservations?: RecoveryTarget['deploymentObservations'];
  deploymentExclusions?: RecoveryTarget['deploymentExclusions'];
  intentionalEmpty?: boolean;
  inputDrift?: boolean;
  expectationConfirmed?: boolean;
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
  extraObserved: Array<Omit<Pick<RecoveryTarget, 'pluginId' | 'agent' | 'scope' | 'delivery' | 'observation' | 'content' | 'backend' | 'deploymentObservations' | 'expectedVersion' | 'installedVersion'>, 'agent'>
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
  observeNative?: boolean;
}

const NATIVE_READ_ERRORS = new Set(['nativeStateUnreadable', 'stateInventoryFailed', 'configReadFailed',
  'configInvalid', 'componentInspectionFailed', 'targetInspectionFailed', 'codexNativeObservationFailed',
  'nativeObservationFailed', 'nativeObservationUnavailable']);
function diagnostic(code: string): RecoveryDiagnostic { return { code, message: `目标尚未满足：${code}。` }; }

async function readAdapterObservations(options: ReadRecoveryStatusOptions, context: ScopeContext,
  demand: DemandSnapshot): Promise<{ observations: NativeObservation[];
    existing: NonNullable<RecoveryStatus['existingTargets']>; owned: NonNullable<RecoveryStatus['ownedTargets']> }> {
  const observations: NativeObservation[] = [];
  const existing: NonNullable<RecoveryStatus['existingTargets']> = [];
  const owned: NonNullable<RecoveryStatus['ownedTargets']> = [];
  let selected: PlatformName[];
  try {
    selected = selectAgents({ preferences: demand.preferences, targets: options.targets }).agents
      .filter((agent): agent is PlatformName => agent !== 'generic');
  } catch { return { observations, existing, owned }; }
  const ctx: ReadContext = { cwd: context.executionCwd, env: context.env, signal: options.signal, runner: options.nativeCliRunner,
    codexObservationSession: options.codexObservationSession, observeNative: options.observeNative };
  for (const platform of selected) {
    options.signal?.throwIfAborted();
    const roots = (demand.roots ?? []).filter((root) => root.plugin
      && resolveDelivery(root.plugin.manifest, platform, demand.scope)?.kind === 'native'
      && (!demand.targetRequirements || demand.targetRequirements.some((item) => item.pluginId === root.pluginId && item.target === platform)));
    if (!roots.length) continue;
    const adapter = getAgentPluginAdapter(platform);
    let ownedSession: CodexNativeObservationSession | undefined;
    try {
      const discovery = await adapter.discover(ctx);
      if (platform === 'codex') {
        const product = discovery.installations.find((item) => item.availability === 'available' && item.entry?.kind === 'cli');
        if (product) {
          const invocation = await installationInvocation(product, ctx, []);
          const manager = { kind: product.product === 'app' ? 'app' as const : 'system' as const, version: product.version ?? 'unknown',
            command: invocation.command, argsPrefix: invocation.args };
          if (ctx.codexObservationSession) ctx.codexObservationSession.setManager(manager);
          else {
            ownedSession = await createCodexNativeObservationSession({ exactCwd: context.executionCwd, env: context.env, manager,
              runner: async (request) => {
                const result = await runNativeCli({ ...request, signal: options.signal, timeoutMs: DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS }, options.nativeCliRunner);
                if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 1024 * 1024) throw new Error('nativeObservationOutputLimit');
                return result;
              } });
            ctx.codexObservationSession = ownedSession;
          }
        }
      }
      for (const root of roots) {
        options.signal?.throwIfAborted();
        const observation: NativeObservation = { pluginId: root.pluginId, expectedVersion: root.plugin?.manifest.version, platform, content: 'unknown', blockers: [], deploymentObservations: [] };
        observations.push(observation);
        try {
          const plugin = root.plugin!;
          const resolution = await adapter.resolve(ctx, { plugin: {
            sourceId: plugin.sourceId ?? root.sourceId, sourceIdentity: plugin.sourceIdentity!,
            pluginId: root.pluginId, version: plugin.manifest.version,
          }, scope: demand.scope === 'project' ? { kind: 'project', projectRoot: context.projectRoot! } : { kind: 'user' },
          operation: 'ensure', discovery, recoveryCandidates: [] });
          observation.deploymentExclusions = resolution.exclusions.flatMap((entry) => entry.productId ? [{
            platform, pluginId: root.pluginId,
            scope: demand.scope === 'project' ? { kind: 'project' as const, projectRoot: context.projectRoot! } : { kind: 'user' as const },
            productId: entry.productId, product: discovery.installations.find((product) => product.id === entry.productId) ?? null,
            reasonCode: entry.reasonCode, execution: 'not-run' as const,
            recoveryActions: ['aw target list', `aw plugin sync ${root.pluginId} --context ${demand.scope} --target ${platform}`],
          }] : []);
          observation.blockers.push(...resolution.exclusions.map((entry) => diagnostic(entry.reasonCode)),
            ...resolution.diagnostics.map((entry) => ({ code: entry.code, message: entry.message })));
          if (!resolution.bindings.length) {
            observation.blockers.push(...discovery.diagnostics.map((entry) => ({ code: entry.code, message: entry.message })));
            if (!observation.blockers.length) observation.blockers.push(diagnostic(discovery.availability === 'missing' ? 'client-missing' : 'nativeObservationUnavailable'));
            continue;
          }
          const states: NativeObservation['content'][] = [];
          const emptyMatches: boolean[] = [];
          const currentMatches: boolean[] = [];
          const versions: Array<string | undefined> = [];
          for (const binding of resolution.bindings) {
            const live = await adapter.inspect(ctx, binding);
            versions.push(live.packageVersion);
            options.signal?.throwIfAborted();
            observation.deploymentObservations!.push({ bindingId: binding.id, products: binding.consumers, after: live });
            observation.blockers.push(...live.diagnostics.map((entry) => ({ code: entry.code, message: entry.message })));
            const shared = ['codex-marketplace', 'claude-marketplace', 'gemini-extension', 'copilot-marketplace'].includes(binding.route);
            const scopedNativeConsumer = shared ? live.registration === 'present'
              && live.consumers.some((consumer) => consumer.activation === 'enabled')
              : live.package === 'present' && live.ownership === 'aw';
            if (scopedNativeConsumer && (live.ownership === 'aw' || live.ownership === 'shared')) {
              owned.push({ pluginId: root.pluginId, agent: platform, scope: demand.scope });
              existing.push({ pluginId: root.pluginId, agent: platform, scope: demand.scope });
            }
            const unmet = [];
            const staticComponents: PluginComponent[] = [];
            const staticSupplements: PluginComponent[] = [];
            const inputUnits: Parameters<typeof createPlatformInputEvidence>[0]['units'] = [];
            const profile = getQualifiedPlatformProfile(platform);
            let expectedCount = 0;
            let packageExpectedCount = 0;
            for (const unit of resolution.renderUnits.filter((unit) => binding.renderUnitIds.includes(unit.id))) {
              const capabilities = adapter.capabilities({ binding, renderUnit: unit, observation: live,
                profile });
              const expected = await normalizeStaticPluginComponents({ pluginRoot: plugin.rootDir,
                manifest: plugin.manifest, platform, capabilities, allowedOutputKinds: unit.kinds });
              expectedCount += expected.components.length;
              staticComponents.push(...expected.components);
              if (unit.output === 'supplement') staticSupplements.push(...expected.components);
              else packageExpectedCount += expected.components.length;
              unmet.push(...expected.unmet);
              inputUnits.push({ renderUnit: unit, capabilities, prerequisites: live.prerequisites,
                config: await resolveArtifactRenderConfig({ pluginName: plugin.manifest.name, sourceId: binding.plugin.sourceId,
                  sourceIdentity: binding.plugin.sourceIdentity, logicalIdentity: plugin.catalogLogicalIdentity,
                  manifest: plugin.manifest, platform, scope: unit.renderScope.kind,
                  cwd: unit.renderScope.kind === 'project' ? unit.renderScope.projectRoot : context.executionCwd,
                  env: context.env, referencePlugins: demand.plugins }) });
            }
            const supplements = await inspectStaticSupplements(ctx, binding, staticSupplements);
            const supplementConflict = supplements.components.some((component) => component.reasonCodes.includes('supplementOwnershipConflict'));
            const supplementDrift = supplements.components.some((component) => component.presence === 'absent'
              || component.reasonCodes.includes('componentContentDrift'));
            const supplementUnknown = supplements.components.some((component) => component.presence === 'unknown');
            if (supplementConflict) observation.blockers.push(diagnostic('supplementOwnershipConflict'));
            else if (supplementDrift) observation.blockers.push(diagnostic('platformContentDrift'));
            else if (supplementUnknown) observation.blockers.push(diagnostic('componentOutputUnconfirmed'));
            if (supplements.owned && !existing.some((target) => target.pluginId === root.pluginId && target.agent === platform && target.scope === demand.scope)) {
              owned.push({ pluginId: root.pluginId, agent: platform, scope: demand.scope });
              existing.push({ pluginId: root.pluginId, agent: platform, scope: demand.scope });
            }
            const inputEvidence = await createPlatformInputEvidence({ plugin, binding, units: inputUnits });
            const confirmedEmpty = Boolean(plugin.manifest.artifacts && expectedCount === 0 && unmet.length === 0
              && await matchesPlatformEmptyState({ state: { ...inputEvidence, kind: 'aw-platform-empty-state', result: 'intentional-empty' }, env: context.env }));
            const dynamicSupplementsUnconfirmed = Boolean(plugin.manifest.artifacts && !confirmedEmpty
              && inputUnits.some(({ renderUnit }) => renderUnit.output === 'supplement'
                && (!plugin.manifest.artifacts?.scopes || plugin.manifest.artifacts.scopes.includes(renderUnit.renderScope.kind))));
            let inputDrift = false;
            let currentProjection = false;
            let projectionUnconfirmed = false;
            if (live.package === 'present' && live.ownership === 'aw') {
              const layout = await getDeploymentLayout(ctx, binding);
              const marker = await readSkillOwnerMarker({ skillRoot: layout.packageRoot, allowedRoot: path.dirname(layout.packageRoot),
                expectedIdentity: deploymentPackageComponent(binding, layout).identity });
              const projection = marker?.nativeProjection;
              const contentDigest = projection ? await readPlatformPackageContentDigest(layout.packageRoot) : undefined;
              projectionUnconfirmed = !projection || projection.preparation !== 'complete';
              const packageInputDigest = platformPackageInputDigest(inputEvidence);
              inputDrift = Boolean(projection && (projection.inputDigest !== packageInputDigest
                || projection.contentDigest !== contentDigest));
              if (projectionUnconfirmed) observation.blockers.push(diagnostic(projection?.preparation === 'partial'
                ? 'platformPreparationPartial' : 'platformExpectationUnconfirmed'));
              else if (inputDrift) observation.blockers.push(diagnostic(projection!.inputDigest !== packageInputDigest
                ? 'platformInputDrift' : 'platformContentDrift'));
              currentProjection = Boolean(projection && !inputDrift && projection.preparation === 'complete'
                && projection.components.length > 0 && projection.components.every((component) =>
                  live.components.some((observed) => observed.id === component.id && observed.presence === 'present'))
                && !supplementConflict && !supplementDrift && !supplementUnknown && !dynamicSupplementsUnconfirmed);
              if (currentProjection) expectedCount = Math.max(expectedCount, projection!.components.length);
            }
            // Codex CLI 0.167.0 loads user plugin Skills without the independent
            // Hook/project trust gate. This is component applicability, not trust
            // inferred from activation, and requires complete current evidence.
            if (binding.route === 'codex-marketplace' && binding.scope.kind === 'user'
              && !plugin.manifest.artifacts && staticComponents.length > 0
              && staticComponents.every((component) => component.kind === 'skill')
              && unmet.length === 0 && staticSupplements.length === 0 && currentProjection
              && live.registration === 'present' && profile.kinds.skill.status === 'supported'
              && binding.consumers.length > 0 && live.consumers.length === binding.consumers.length
              && binding.consumers.every((product) => product.product === 'cli' && product.availability === 'available'
                && product.version === '0.167.0' && profile.qualifiedConsumers?.skill?.some((qualified) =>
                  qualified.product === product.product && qualified.version === product.version)
                && live.consumers.filter((consumer) => consumer.productId === product.id
                  && consumer.activation === 'enabled' && ['unknown', 'trusted', 'not-applicable'].includes(consumer.trust)).length === 1)) {
              for (const consumer of live.consumers) if (consumer.trust === 'unknown') consumer.trust = 'not-applicable';
            }
            live.components.push(...supplements.components);
            observation.inputDrift ||= inputDrift || supplementDrift;
            currentMatches.push(confirmedEmpty || currentProjection);
            emptyMatches.push(confirmedEmpty);
            observation.blockers.push(...unmet.map((entry) => diagnostic(entry.reasonCode)));
            const requiresComponents = expectedCount > 0 || unmet.length > 0 || Boolean(plugin.manifest.artifacts);
            if (!confirmedEmpty && requiresComponents && live.consumers.some((consumer) =>
              consumer.trust === 'required' || consumer.trust === 'blocked')
              && !observation.blockers.some((entry) => entry.code === 'nativeTrustRequired')) {
              observation.blockers.push(diagnostic('nativeTrustRequired'));
            }
            const supplementOnly = !plugin.manifest.artifacts && staticSupplements.length > 0 && packageExpectedCount === 0;
            const absent = !supplementOnly && live.package === 'absent' && ['absent', 'not-applicable'].includes(live.registration);
            const unknown = !supplementOnly && (live.package === 'unknown' || live.registration === 'unknown'
              || live.consumers.some((consumer) => consumer.activation === 'unknown' || consumer.trust === 'unknown'));
            const inactive = !supplementOnly && (live.registration === 'absent' || live.consumers.some((consumer) => consumer.activation === 'disabled' || consumer.activation === 'blocked'
              || consumer.trust === 'blocked' || consumer.trust === 'required'));
            if (confirmedEmpty) {
              const inactiveScope = live.consumers.every((consumer) => ['disabled', 'not-applicable'].includes(consumer.activation));
              states.push(live.ownership === 'foreign' ? 'conflict' : live.package === 'unknown' || live.registration === 'unknown'
                || live.diagnostics.length || !inactiveScope ? 'unknown'
                : live.package === 'absent' || shared ? 'satisfied' : 'drifted');
            } else states.push(live.ownership === 'foreign' || supplementConflict ? 'conflict' : projectionUnconfirmed || supplementUnknown ? 'unknown' : inputDrift || supplementDrift ? 'drifted' : unmet.length || dynamicSupplementsUnconfirmed ? 'unknown'
              : !expectedCount ? absent ? 'satisfied' : unknown ? 'unknown' : 'drifted'
                : absent ? 'absent' : unknown ? 'unknown' : inactive ? 'drifted' : supplementOnly || live.package === 'present' ? 'satisfied' : 'unknown');
          }
          observation.intentionalEmpty = emptyMatches.length === resolution.bindings.length && emptyMatches.every(Boolean);
          observation.expectationConfirmed = currentMatches.length === resolution.bindings.length && currentMatches.every(Boolean);
          if (versions.length && versions[0] && versions.every((version) => version === versions[0])) observation.installedVersion = versions[0];
          observation.content = (['conflict', 'drifted', 'absent', 'unknown'] as const)
            .find((state) => states.includes(state)) ?? 'satisfied';
        } catch (error) {
          rethrowFatalError(error);
          options.signal?.throwIfAborted();
          observation.content = 'unknown'; observation.blockers.push(diagnostic('nativeObservationFailed'));
        }
      }
    } catch (error) {
      rethrowFatalError(error);
      options.signal?.throwIfAborted();
      for (const root of roots) observations.push({ pluginId: root.pluginId, platform, content: 'unknown', blockers: [diagnostic('nativeObservationFailed')] });
    } finally {
      if (ownedSession) {
        try { await ownedSession.dispose(); } finally { ctx.codexObservationSession = undefined; }
      }
    }
  }
  return { observations, existing, owned };
}
function safeNativePlacement(target: StatusScopedTarget): unknown {
  const component = ({ kind, key, state, metadata }: StatusScopedTarget['components'][number]) => ({
    kind, key, state,
    ...(metadata ? { metadata: Object.fromEntries(Object.entries(metadata).filter(([name]) =>
      ['enabled', 'scopes', 'relation', 'errorCode', 'shared', 'version', 'desiredVersion',
        'staleCacheObserved', 'effective', 'requiredMinVersion', 'detectedVersion', 'code',
        'kinds', 'platform', 'scope', 'project', 'rootIssueId', 'rootIssueCode'].includes(name)
        || (kind === 'systemConsumer' && name === 'diagnostics'))) } : {}),
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
    if (root.plugin) {
      try {
        const closure = root.plugin.manifest.dependencies?.length
          ? resolvePluginMetaDependencyClosure(demand.plugins.filter((plugin) => plugin.sourceId === root.sourceId), [root.plugin.manifest.name])
          : [root.plugin];
        for (const plugin of closure) {
          const support = checkAwCapabilitySupport(plugin.manifest.requires?.aw.capabilities ?? [], IMPLEMENTED_AW_CAPABILITIES);
          if (!support.supported) blockers.push({ ...diagnostic('awCapabilityUnsupported'), pluginId: plugin.pluginId });
        }
      } catch { blockers.push(diagnostic('dependencyContractInvalid')); }
    }
    if (!selection.agents.length) blockers.push(diagnostic('localTargetsRequired'));
    const targetResults: RecoveryTarget[] = [];
    for (const agent of selection.agents) {
      if (demand.targetRequirements && !demand.targetRequirements.some((item) => item.pluginId === root.pluginId && item.target === agent)) continue;
      options.signal?.throwIfAborted();
      const delivery = root.plugin ? resolveDelivery(root.plugin.manifest, agent, options.scope) ?? null : null;
      const target: RecoveryTarget = { pluginId: root.pluginId, agent, scope: options.scope, delivery,
        execution: 'not-run', observation: 'unknown', content: 'unknown', blockers: [...blockers],
        requiredBy: [root.pluginId], relation: 'root',
        ...(root.plugin?.manifest.version ? { expectedVersion: root.plugin.manifest.version } : {}) };
      if (blockers.length) { targetResults.push(target); continue; }
      if (!delivery) target.blockers.push(diagnostic('deliveryUnsupported'));
      else if (delivery.kind === 'native') {
        const native = options.nativeObservations.find((entry) => entry.pluginId === root.pluginId
          && entry.platform === delivery.platform);
        if (native) {
          target.content = native.content;
          if (native.installedVersion) target.installedVersion = native.installedVersion;
          if (native.deploymentObservations) target.deploymentObservations = native.deploymentObservations;
          if (native.deploymentExclusions) target.deploymentExclusions = native.deploymentExclusions;
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
          const gaps = (portable.unmet ?? []).filter((gap) => gap.agent === agent);
          if (gaps.length) {
            target.componentGaps = gaps;
            if (!target.blockers.some((entry) => entry.code === 'portableComponentsUnmet')) target.blockers.push(diagnostic('portableComponentsUnmet'));
          }
          const observed = portable.targets.filter((entry) => entry.agent === agent);
          target.blockers.push(...observed.flatMap((entry) => entry.blocker ? [diagnostic(entry.blocker)] : []));
          target.content = (['conflict', 'drifted', 'absent', 'unknown'] as const)
            .find((state) => observed.some((entry) => entry.observation === state))
            ?? (!portable.blockers.length && (observed.length || portable.intentionalEmpty && gaps.length === 0) ? 'satisfied' : 'unknown');
          if (observed.length === 0 && portable.blockers.includes('needs-preparation') && options.portableCoverage === true
            && options.portableInstalled && !options.portableInstalled.some((item) => item.pluginId === root.pluginId && item.agent === agent)) {
            target.content = 'absent'; target.blockers = target.blockers.filter((item) => item.code !== 'needs-preparation');
          }
          if (gaps.length && target.content !== 'conflict') target.content = 'unknown';
          target.backend = observed.map((entry) => ({ skill: entry.skill, agent: entry.agent,
            ownership: entry.ownership, observation: entry.observation, associatedAgents: entry.associatedAgents }));
          if (target.blockers.some((entry) => /(?:VerificationFailed|ReadFailed|LockInvalid)/u.test(entry.code))) {
            errors.push({ ...diagnostic('portableObservationFailed'), pluginId: root.pluginId });
          }
        } catch (error) {
          rethrowFatalError(error);
          options.signal?.throwIfAborted();
          target.blockers.push(diagnostic('portableObservationFailed'));
          errors.push({ ...diagnostic('portableObservationFailed'), pluginId: root.pluginId });
        }
      }
      const confirmedEmpty = delivery?.kind === 'native' && options.nativeObservations.some((entry) =>
        entry.pluginId === root.pluginId && entry.platform === delivery.platform && (entry.intentionalEmpty === true || entry.expectationConfirmed === true));
      if (delivery?.kind === 'native' && root.plugin?.manifest.artifacts && !confirmedEmpty) {
        const inputDrift = delivery?.kind === 'native' && options.nativeObservations.some((entry) =>
          entry.pluginId === root.pluginId && entry.platform === delivery.platform && entry.inputDrift === true);
        if (target.content !== 'conflict' && !inputDrift) target.content = 'unknown';
        target.blockers.push(diagnostic('dynamicExpectationUnconfirmed'));
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
      } else if (target.blockers.some((entry) => entry.code === 'awCapabilityUnsupported')) definiteFailure = true;
      else if (target.content === 'unknown' || target.observation === 'unknown' || target.blockers.length) uncertain = true;
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
  onNativeStatus?: (status: RecoveryStatus, demand: DemandSnapshot) => void | Promise<void>;
}): Promise<RecoveryStatus> {
  options.signal?.throwIfAborted();
  const context = await createScopeContext({ scope: options.scope, cwd: options.cwd, env: options.env, readOnly: true });
  try {
    options.signal?.throwIfAborted();
    const demand = options.demandOverride ?? await readDemand({ scope: options.scope, cwd: context.executionCwd, env: context.env,
      catalogOperationContext: options.catalogOperationContext, signal: options.signal });
    options.signal?.throwIfAborted();
    options.onDemand?.(demand);
    options.signal?.throwIfAborted();
    const ownerInventory = options.nativeObservations ? { references: [], errors: [] }
      : await inventoryCatalogSourceReferences({ cwd: context.executionCwd, env: context.env, scope: options.scope });
    options.signal?.throwIfAborted();
    const candidates = ownerInventory.references.filter((entry) => entry.scope === options.scope
      && entry.sourceId && entry.pluginName && isPlatformTarget(entry.platform) && entry.platform !== 'generic');
    const observedPlugins = new Map(demand.plugins.map((plugin) => [plugin.pluginId, plugin]));
    let catalog = demand.catalogOperationContext ?? options.catalogOperationContext;
    if (candidates.some((entry) => !observedPlugins.has(`${entry.sourceId}/${entry.pluginName}`))) {
      try { catalog ??= await resolvePartialCatalogOperationContext({ env: context.env, signal: options.signal }); }
      catch (error) {
        rethrowFatalError(error);
        options.signal?.throwIfAborted();
      }
      for (const candidate of candidates) {
        const pluginId = `${candidate.sourceId}/${candidate.pluginName}`;
        if (observedPlugins.has(pluginId)) continue;
        const source = catalog?.catalog.sources.find((entry) => entry.sourceId === candidate.sourceId)?.resolution;
        if (!source?.manifest.entries.some((entry) => entry.name === candidate.pluginName)) continue;
        try {
          const plugin = await readPluginManifest(path.join(source.rootDir, 'plugins', candidate.pluginName!), { mode: 'bundle' });
          Object.assign(plugin, { pluginId, sourceId: candidate.sourceId, sourceIdentity: source.sourceIdentity,
            catalogLogicalIdentity: source.logicalIdentity });
          observedPlugins.set(pluginId, plugin);
        } catch (error) {
          rethrowFatalError(error);
          options.signal?.throwIfAborted();
        }
      }
    }
    let selectedAgents: AgentId[] = [];
    try { selectedAgents = selectAgents({ preferences: demand.preferences, targets: options.targets }).agents; }
    catch { /* The status result reports invalid strong state without extending observations. */ }
    const observationDemand: DemandSnapshot = { ...demand, plugins: [...observedPlugins.values()],
      roots: [...new Map([...(demand.roots ?? []), ...candidates.flatMap((candidate) => {
        const pluginId = `${candidate.sourceId}/${candidate.pluginName}`;
        const plugin = observedPlugins.get(pluginId);
        return plugin ? [{ pluginId, sourceId: candidate.sourceId!, plugin, sourceState: 'ready' as const, blockers: [] }] : [];
      })].map((root) => [root.pluginId, root])).values()],
      targetRequirements: demand.targetRequirements ? [...demand.targetRequirements,
        ...candidates.map((entry) => ({ pluginId: `${entry.sourceId}/${entry.pluginName}`, target: entry.platform as PlatformName }))] : undefined };
    const adapters = options.nativeObservations ? { observations: [], existing: [], owned: [] }
      : await readAdapterObservations({ ...options, targets: [...new Set([...selectedAgents, ...candidates.map((entry) => entry.platform!)])] }, context, observationDemand);
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
    const nativeExtraObserved: RecoveryStatus['extraObserved'] = adapters.owned
      .filter((entry) => !expected(entry.pluginId, entry.agent))
      .map((entry) => ({ ...entry,
        expectedVersion: adapters.observations.find((item) => item.pluginId === entry.pluginId && item.platform === entry.agent)?.expectedVersion,
        installedVersion: adapters.observations.find((item) => item.pluginId === entry.pluginId && item.platform === entry.agent)?.installedVersion,
        delivery: { kind: 'native', platform: entry.agent as PlatformName },
        observation: 'unknown', content: 'unknown', deploymentObservations: adapters.observations.find((observation) =>
          observation.pluginId === entry.pluginId && observation.platform === entry.agent)?.deploymentObservations }));
    const inventoryOwned = candidates.flatMap((entry) => entry.ownedComponent
      && !['codex', 'claude', 'gemini', 'copilot'].includes(entry.platform!)
      ? [{ pluginId: `${entry.sourceId}/${entry.pluginName}`, agent: entry.platform as PlatformName, scope: options.scope }] : []);
    for (const entry of inventoryOwned) {
      if (!expected(entry.pluginId, entry.agent) && !nativeExtraObserved.some((target) => target.pluginId === entry.pluginId && target.agent === entry.agent)) {
        nativeExtraObserved.push({ ...entry, delivery: { kind: 'native', platform: entry.agent }, observation: 'unknown', content: 'unknown' });
      }
    }
    for (const entry of candidates) {
      const component = entry.ownedComponent;
      if (component?.kind !== 'owned-directory' || !['codex', 'claude', 'gemini', 'copilot'].includes(entry.platform!)
        || component.identity.scope !== options.scope || entry.recoveryCandidate?.evidence !== 'verified'
        || component.identity.sourceId !== entry.sourceId || component.identity.sourceIdentity !== entry.sourceIdentity
        || component.identity.platform !== entry.platform || component.identity.pluginId !== `${entry.sourceId}/${entry.pluginName}`
        || component.identity.physicalKey !== entry.recoveryCandidate.binding.physicalKey) continue;
      const pluginId = component.identity.pluginId!;
      if (observedPlugins.get(pluginId)?.sourceIdentity === component.identity.sourceIdentity) continue;
      nativeExtraObserved.push({ pluginId, agent: entry.platform as PlatformName, scope: component.identity.scope,
        delivery: { kind: 'native', platform: entry.platform as PlatformName }, observation: 'unknown', content: 'unknown',
        backend: { retainedPackage: true, ownedComponents: [{ ...component, state: 'present' }] } });
    }
    const portableExtra = await inspectPortableExtraInstalled({
      scope: options.scope, context, env: context.env, signal: options.signal,
    });
    options.signal?.throwIfAborted();
    const portableObserved: RecoveryStatus['extraObserved'] = portableExtra.targets
      .filter((entry) => !expected(entry.pluginId, entry.agent))
      .map((entry) => ({ pluginId: entry.pluginId, agent: entry.agent, scope: options.scope,
        delivery: { kind: 'agent-skills', provider: 'aw', agentId: 'generic' },
        observation: entry.observation, content: entry.content,
        backend: { skill: entry.skill, logicalIdentity: entry.logicalIdentity } }));
    const extraObserved = [...nativeExtraObserved, ...portableObserved];
    const result = await statusFromObservations({ ...options, context, demand,
      nativeObservations: options.nativeObservations ?? adapters.observations, extraObserved,
      portableCoverage: portableExtra.complete, portableInstalled: portableExtra.targets,
      nativeReadErrors: [
        ...ownerInventory.errors.map((error) => ({ code: error.kind === 'nativeStateRead' ? 'nativeStateUnreadable' : error.code })),
        ...adapters.observations.flatMap((entry) => entry.blockers.filter((error) => NATIVE_READ_ERRORS.has(error.code))),
      ].map((error) => diagnostic(error.code)) });
    result.existingTargets = [
      ...adapters.existing,
      ...portableExtra.targets.map((target) => ({ pluginId: target.pluginId, agent: target.agent, scope: options.scope })),
    ];
    result.ownedTargets = [
      ...adapters.owned, ...inventoryOwned,
      ...portableExtra.targets.map((target) => ({ pluginId: target.pluginId, agent: target.agent, scope: options.scope })),
    ];
    await options.onNativeStatus?.(result, demand);
    options.signal?.throwIfAborted();
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
  onNativeStatus?: (status: RecoveryStatus, demand: DemandSnapshot) => void | Promise<void>;
}, preparedDemand?: JointDemandSnapshot): Promise<RecoveryStatus> {
  const snapshot = preparedDemand ?? await readJointDemand(options);
  if (options.codexObservationSession || options.nativeObservations) {
    return readRecoveryStatusInSession(options, snapshot);
  }
  const context = await createScopeContext({ scope: snapshot.context.context,
    cwd: snapshot.context.projectRoot ?? options.cwd, env: options.env, readOnly: true });
  let session: CodexNativeObservationSession | undefined;
  try {
    options.signal?.throwIfAborted();
    session = await createCodexNativeObservationSession({ exactCwd: context.executionCwd, env: context.env,
      runner: async (request) => {
        const result = await runNativeCli({ ...request, signal: options.signal,
          timeoutMs: DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS }, options.nativeCliRunner);
        if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 1024 * 1024) throw new Error('nativeObservationOutputLimit');
        return result;
      } });
    // User reads use only this session's neutral cwd. Project reads add the
    // exact project snapshot without repeating the same neutral observation.
    return await readRecoveryStatusInSession({ ...options, codexObservationSession: session }, snapshot);
  } finally {
    try { await session?.dispose(); } finally { await context.dispose(); }
  }
}

async function readRecoveryStatusInSession(options: ReadRecoveryStatusOptions & {
  onDemand?: (demand: DemandSnapshot) => string[] | undefined;
  onNativeStatus?: (status: RecoveryStatus, demand: DemandSnapshot) => void | Promise<void>;
}, snapshot: JointDemandSnapshot): Promise<RecoveryStatus> {
  const plan = deriveJointDemand(snapshot);
  const scopes = [snapshot.user, ...(snapshot.project ? [snapshot.project] : [])];
  const observed: RecoveryStatus[] = [];
  for (const demand of scopes) {
    const nodes = plan.placements.filter((item) => item.scope === demand.scope
      || demand.scope === 'project' && ['codex', 'claude', 'gemini', 'copilot'].includes(item.target)
        && item.contributions.some((contribution) => contribution.scope === 'project'));
    const expanded: DemandSnapshot = { ...demand,
      userProviders: demand.scope === 'project' ? Object.fromEntries((snapshot.preferences?.targets ?? []).map((target) => [target,
        plan.placements.filter((item) => item.scope === 'user' && item.target === target
          && !nodes.some((project) => project.scope === 'project' && project.pluginId === item.pluginId && project.target === item.target)).map((item) => item.pluginId)])) : {},
      targetRequirements: nodes.map((item) => ({ pluginId: item.pluginId, target: item.target })), roots: demand.roots === null ? null : [...new Map(nodes.map((item) => [item.pluginId, {
      pluginId: item.pluginId, sourceId: item.plugin.sourceId!, sourceState: 'ready' as const,
      blockers: [], plugin: item.plugin,
    }])).values()] };
    observed.push(await readScopedRecoveryStatus({ ...options, onNativeStatus: undefined, scope: demand.scope,
      cwd: snapshot.context.projectRoot ?? options.cwd, targets: undefined, demandOverride: expanded }));
  }
  const allTargets = observed.flatMap((status) => status.inventory?.flatMap((item) => item.targetResults) ?? []).map((target) => {
    const providers = plan.placements.filter((placement) => placement.pluginId === target.pluginId && placement.target === target.agent
      && (placement.scope === target.scope || target.scope === 'project'
        && ['codex', 'claude', 'gemini', 'copilot'].includes(target.agent) && placement.scope === 'user'
        && placement.contributions.some((entry) => entry.scope === 'project')));
    const contributions = providers.flatMap((provider) => provider.contributions
      .filter((entry) => provider.scope === target.scope || entry.scope === target.scope));
    return { ...target, contributions: contributions.map((entry) => ({ root: entry.root, scope: entry.scope, path: [...entry.path] })),
      requiredBy: [...new Set(contributions.map((entry) => entry.root))], providerScope: providers[0]?.scope,
      relation: contributions.some((entry) => entry.path.length === 1 && entry.scope === target.scope) ? 'root' as const : 'dependency' as const };
  });
  const inventory: RecoveryStatus['inventory'] = scopes.some((demand) => demand.roots !== null) ? [] : null;
  const visibleInventory: NonNullable<RecoveryStatus['inventory']> = [];
  for (const demand of scopes) for (const root of demand.roots ?? []) {
    const targetResults: RecoveryTarget[] = [];
    for (const requirement of plan.roots.filter((entry) => entry.scope === demand.scope && entry.pluginId === root.pluginId)) {
      const placement = plan.placements.find((item) => item.pluginId === root.pluginId && item.target === requirement.target
        && item.contributions.some((contribution) => contribution.scope === demand.scope && contribution.root === root.pluginId));
      const target: RecoveryTarget = { pluginId: root.pluginId, agent: requirement.target, scope: demand.scope,
        requirementScope: demand.scope, providerScope: placement?.scope,
        delivery: root.plugin ? resolveDelivery(root.plugin.manifest, requirement.target, demand.scope) ?? null : null,
        execution: 'not-run', observation: 'unknown', content: 'unknown', requiredBy: [root.pluginId], relation: 'root',
        ...(root.plugin?.manifest.version ? { expectedVersion: root.plugin.manifest.version } : {}), blockers: [...requirement.blockers] };
      if (requirement.state === 'excluded' || requirement.state === 'unsupported') {
        target.satisfaction = requirement.state; target.content = 'satisfied'; target.observation = 'verified';
        if (requirement.reasons?.length) target.reasons = requirement.reasons;
      } else if (requirement.state === 'required') {
        const providers = requirement.dependencies.map((id) => {
          const provider = plan.placements.find((item) => item.pluginId === id && item.target === requirement.target
            && item.contributions.some((contribution) => contribution.scope === demand.scope && contribution.root === root.pluginId));
          const actual = allTargets.find((item) => item.pluginId === id && item.agent === requirement.target && item.scope === provider?.scope);
          if (demand.scope === 'project' && provider?.scope === 'user' && ['codex', 'claude', 'gemini', 'copilot'].includes(requirement.target)) {
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
        const ownProvider = providers.find((provider) => provider?.pluginId === root.pluginId);
        if (ownProvider?.installedVersion) target.installedVersion = ownProvider.installedVersion;
        target.blockers.push(...providers.flatMap((item) => item?.blockers ?? []));
        const componentGaps = providers.flatMap((item) => item?.componentGaps ?? []);
        if (componentGaps.length) target.componentGaps = [...new Map(componentGaps.map((gap) =>
          [JSON.stringify([gap.providerPluginId, gap.agent, gap.renderScope, gap.id]), gap])).values()];
        const exclusions = providers.flatMap((item) => item?.deploymentExclusions ?? []);
        if (exclusions.length) target.deploymentExclusions = [...new Map(exclusions.map((exclusion) =>
          [JSON.stringify([exclusion.pluginId, exclusion.platform, exclusion.scope, exclusion.productId, exclusion.reasonCode]), exclusion])).values()];
        const deployments = providers.flatMap((item) => item?.deploymentObservations ?? []);
        if (deployments.length) target.deploymentObservations = [...new Map(deployments.map((item) => [item.bindingId, item])).values()];
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
  const targets = visibleInventory.flatMap((item) => item.targetResults);
  const knownFailure = plan.errors.some((error) => ['targetsNotConfigured', 'dependencyExcluded', 'dependencyContractInvalid', 'targetPlacementConflict'].includes(error.code))
    || targets.some((target) => ['absent', 'drifted', 'conflict'].includes(target.content ?? 'unknown')
      || target.blockers.some((entry) => entry.code === 'awCapabilityUnsupported'));
  const uncertain = !plan.complete || targets.some((target) => target.content === 'unknown' || target.blockers.length > 0);
  const allSatisfied = knownFailure ? false : uncertain ? null : true;
  const nativeCoverage = observed.every((status) => status.coverage.native);
  const portableCoverage = observed.every((status) => status.coverage.portable);
  const errors = [...plan.errors, ...observed.flatMap((status) => status.errors)];
  const result: RecoveryStatus = { schemaVersion: 1, kind: 'aw-recovery-status', scope: snapshot.context.context, ok: errors.length === 0,
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
  await options.onNativeStatus?.(result, snapshot.context.context === 'project' ? snapshot.project! : snapshot.user);
  options.signal?.throwIfAborted();
  return result;
}
