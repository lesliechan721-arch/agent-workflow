import path from 'node:path';
import { isPlatformTarget, normalizeStaticPluginComponents, type ComponentUnmet, type PluginComponent } from '@lesliechan721/aw-plugin-core/manifest';
import type { PlatformName, Scope } from '../types.js';
import { selectAgents, type AgentId } from '../intent/deployment-preferences.js';
import { createScopeContext, type ScopeContext } from '../intent/scope-context.js';
import { resolveIntentPath } from '../intent/intent-store.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import type { StatusScopedTarget } from '../commands/status-v6.js';
import { inspectPortableExtraInstalled, inspectPortableRecovery, portablePreparationDiagnostic } from '../portable/recovery.js';
import { readJointDemand, deriveJointDemand, type JointDemandSnapshot } from './joint-demand.js';
import { readDemand, resolveDelivery, type DemandSnapshot } from './demand.js';
import { retainedOutputDiagnostic, scopeNativeComponentGaps, uniqueRecoveryComponentGaps, type RecoveryDiagnostic, type RecoveryReceipt, type RecoveryTarget } from './receipt.js';
import type { CatalogOperationContext } from '../utils/catalog-operation-context.js';
import { runNativeCli, type NativeCliRunner } from '../utils/native-cli.js';
import { rethrowFatalError } from '../utils/codex-executable-discovery.js';
import { createCodexNativeObservationSession, type CodexNativeObservationSession } from '../utils/codex-native-observation.js';
import { getAgentPluginAdapter } from '../platforms/registry.js';
import { getQualifiedPlatformProfile } from '../platforms/capabilities.js';
import { isDeliveryCapabilityGap } from '../utils/component-gap.js';
import { piAgentConsumerDiagnostic } from '../platforms/inspection-pi.js';
import { gapSupplementFiles } from '../platforms/supplement-layout.js';
import { inspectPlatformSupplementState } from '../platforms/supplement-state.js';
import { resolveArtifactRenderConfig } from '../utils/artifact-renderer.js';
import { createPlatformInputEvidence, matchesPlatformEmptyState, readPlatformDeliveryState, platformPackageInputDigest, readPlatformPackageContentDigest } from '../utils/platform-empty-state.js';
import { deliveryNoticeMessage, INVOCATION_POLICY_NOT_APPLIED } from '../output/component-delivery.js';
import { piProjectEmptyDeliveryObserved } from '../platforms/lifecycle-native.js';
import { getDeploymentLayout, hasSharedUserPackage } from '../platforms/layout.js';
import { identityDigest } from '../platforms/identity.js';
import { deploymentPackageComponent, inspectStaticSupplements, requiredDeploymentActivation } from '../platforms/inspection.js';
import { resolveStaticPlatformResourceRoot } from '../utils/component-resources.js';
import { inspectOwnedComponents, readSkillOwnerMarker } from '../utils/ownership.js';
import { inventoryCatalogSourceReferences, type CatalogSourceReference } from '../utils/catalog-source-references.js';
import { resolvePartialCatalogOperationContext, type CatalogPreparationReadScope } from '../utils/catalog-operation-context.js';
import { checkAwCapabilitySupport, readPluginManifest } from '../utils/manifest.js';
import { IMPLEMENTED_AW_CAPABILITIES } from '../commands/aw-capabilities.js';
import { resolvePluginMetaDependencyClosure } from '../utils/plugin-dependencies.js';
import { installationInvocation, selectNativeProduct, type ReadContext } from '../platforms/discovery.js';
import { DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS } from '../constants.js';
import { inventoryRecoveryDiagnostic } from '../utils/inventory-recovery-diagnostic.js';
import { measureRecoveryPerformanceStage } from './performance.js';
import { withNativeObservationBatch } from '../platforms/inspection-query.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import { mapInstallReads } from './install-concurrency.js';

export interface NativeObservation {
  pluginId: string;
  expectedVersion?: string;
  installedVersion?: string;
  platform: PlatformName;
  content: NonNullable<RecoveryTarget['content']>;
  blockers: RecoveryDiagnostic[];
  reasons?: RecoveryDiagnostic[];
  assumedActivation?: boolean;
  backend?: unknown;
  deploymentObservations?: RecoveryTarget['deploymentObservations'];
  deploymentExclusions?: RecoveryTarget['deploymentExclusions'];
  componentGaps?: RecoveryTarget['componentGaps'];
  installedComponentIds?: string[];
  intentionalEmpty?: boolean;
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
  coverage: { native: boolean; portable: boolean; scopes?: Scope[]; projectRoot?: string; requestComplete?: boolean };
  inSync: boolean | null;
  counts: { blocked: number; unconfirmed: number; pending: number; ready: number };
  allSatisfied: boolean | null;
  errors: RecoveryDiagnostic[];
}
export interface ReadRecoveryStatusOptions {
  nativeCliRunner?: NativeCliRunner;
  codexObservationSession?: CodexNativeObservationSession;
  catalogOperationContext?: CatalogOperationContext;
  catalogReadScope?: CatalogPreparationReadScope;
  /** Sources observed within one read-only operation, including residual outputs. */
  catalogSources?: Map<string, CatalogOperationContext['catalog']['sources'][number]>;
  scope?: Scope;
  context?: Scope;
  expectedProjectRoot?: string;
  demandOverride?: DemandSnapshot;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cliVersion?: string;
  signal?: AbortSignal;
  targets?: readonly string[];
  nativeObservations?: NativeObservation[];
  observeNative?: boolean;
  plugins?: readonly string[];
  discoveryCache?: ReadContext['discoveryCache'];
  nativeQuerySession?: ReadContext['nativeQuerySession'];
  debugLogger?: import('../commands/runtime.js').CommandExecutionContext['debugLogger'];
  /** Complete graph is resolved before this internal observation selection is set. */
  observationPlugins?: ReadonlySet<string>;
}

const NATIVE_READ_ERRORS = new Set(['nativeStateUnreadable', 'stateInventoryFailed', 'configReadFailed',
  'configInvalid', 'componentInspectionFailed', 'targetInspectionFailed', 'codexNativeObservationFailed',
  'nativeObservationFailed', 'nativeObservationUnavailable']);
function isNativeReadError({ code, detail }: RecoveryDiagnostic, needsOwnership = true): boolean {
  return NATIVE_READ_ERRORS.has(code) || needsOwnership && (code === 'nativeConfigurationUnreadable'
    || code === 'nativeMarketplaceUnconfirmed' && detail !== undefined);
}
export function isTargetObservationReadError(entry: RecoveryDiagnostic): boolean {
  const { code } = entry;
  return isNativeReadError(entry) || code === 'portableObservationFailed' || code === 'portablePreparationFailed'
    || /(?:VerificationFailed|ReadFailed|LockInvalid)/u.test(code);
}
function diagnostic(code: string): RecoveryDiagnostic { return { code, message: `目标尚未满足：${code}。` }; }

function withStatusNativeQueries<T, Options extends ReadRecoveryStatusOptions>(options: Options,
  read: (options: Options) => Promise<T>): Promise<T> {
  if (options.nativeQuerySession) return read(options);
  return withNativeObservationBatch({ runner: options.nativeCliRunner, signal: options.signal }, (batch) => read({ ...options,
    discoveryCache: options.discoveryCache ?? batch.discoveryCache, nativeQuerySession: batch.nativeQuerySession,
    nativeCliRunner: batch.runner }));
}

async function readAdapterObservations(options: ReadRecoveryStatusOptions, context: ScopeContext,
  demand: DemandSnapshot, inventory: readonly CatalogSourceReference[]): Promise<{ observations: NativeObservation[];
    existing: NonNullable<RecoveryStatus['existingTargets']>; owned: NonNullable<RecoveryStatus['ownedTargets']> }> {
  let selected: PlatformName[];
  try {
    selected = selectAgents({ preferences: demand.preferences, targets: options.targets }).agents
      .filter((agent): agent is PlatformName => agent !== 'generic');
  } catch { return { observations: [], existing: [], owned: [] }; }
  const platforms = await mapInstallReads(selected, async (platform) => {
    const observations: NativeObservation[] = [];
    const existing: NonNullable<RecoveryStatus['existingTargets']> = [];
    const owned: NonNullable<RecoveryStatus['ownedTargets']> = [];
    const ctx: ReadContext = { cwd: context.executionCwd, env: context.env, signal: options.signal, runner: options.nativeCliRunner,
      discoveryCache: options.discoveryCache, nativeQuerySession: options.nativeQuerySession,
      codexObservationSession: platform === 'codex' ? options.codexObservationSession : undefined,
      observeNative: options.observeNative };
    options.signal?.throwIfAborted();
    const roots = (demand.roots ?? []).filter((root) => root.plugin
      && resolveDelivery(root.plugin.manifest, platform, demand.scope)?.kind === 'native'
      && (!demand.targetRequirements || demand.targetRequirements.some((item) => item.pluginId === root.pluginId && item.target === platform)));
    if (!roots.length) return { observations, existing, owned };
    const adapter = getAgentPluginAdapter(platform);
    let ownedSession: CodexNativeObservationSession | undefined;
    try {
      const discovery = await measureRecoveryPerformanceStage(options, 'status.discovery', () => adapter.discover(ctx));
      if (platform === 'codex') {
        const product = selectNativeProduct(discovery.installations);
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
        const observation: NativeObservation = { pluginId: root.pluginId, expectedVersion: root.plugin?.manifest.version, platform, content: 'unknown', blockers: [], reasons: [], deploymentObservations: [] };
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
          observation.blockers.push(...resolution.diagnostics.map((entry) => ({ ...entry })));
          if (!resolution.bindings.length) {
            observation.blockers.push(...resolution.exclusions.map((entry) => diagnostic(entry.reasonCode)));
            observation.blockers.push(...discovery.diagnostics.map((entry) => ({ code: entry.code, message: entry.message })));
            if (!observation.blockers.length) observation.blockers.push(diagnostic(discovery.availability === 'missing' ? 'client-missing' : 'nativeObservationUnavailable'));
            continue;
          }
          const states: NativeObservation['content'][] = [];
          const emptyMatches: boolean[] = [];
          const currentMatches: boolean[] = [];
          const versions: Array<string | undefined> = [];
          const deliveredIds = new Set<string>();
          const staticResourceRoot = await resolveStaticPlatformResourceRoot(plugin.rootDir, platform);
          for (const binding of resolution.bindings) {
            const subject = { pluginId: root.pluginId, target: platform, scope: binding.scope.kind };
            const warn = (code: string) => observation.reasons!.push({ ...diagnostic(code), subject });
            const block = (code: string) => observation.blockers.push({ ...diagnostic(code), subject });
            const live = await measureRecoveryPerformanceStage(options, 'status.adapter.inspect', () => adapter.inspect(ctx, binding));
            versions.push(live.packageVersion);
            options.signal?.throwIfAborted();
            observation.deploymentObservations!.push({ bindingId: binding.id, products: binding.consumers, after: live });
            const shared = ['codex-marketplace', 'claude-marketplace', 'copilot-marketplace'].includes(binding.route);
            const scopedNativeConsumer = shared ? live.registration === 'present'
              && live.consumers.some((consumer) => consumer.activation === 'enabled')
              : live.package === 'present' && live.ownership === 'aw';
            if (scopedNativeConsumer && (live.ownership === 'aw' || live.ownership === 'shared')) {
              owned.push({ pluginId: root.pluginId, agent: platform, scope: demand.scope });
              existing.push({ pluginId: root.pluginId, agent: platform, scope: demand.scope });
            }
            const unmet: ComponentUnmet[] = [];
            const staticPackageIds = new Set<string>();
            const staticSupplements: PluginComponent[] = [];
            const dynamicUnits = new Set<(typeof resolution.renderUnits)[number]['output']>();
            const inputUnits: Parameters<typeof createPlatformInputEvidence>[0]['units'] = [];
            const profile = getQualifiedPlatformProfile(platform);
            const renderUnits = resolution.renderUnits.filter((unit) => binding.renderUnitIds.includes(unit.id));
            for (const unit of renderUnits) {
              const artifacts = plugin.manifest.artifacts;
              if (artifacts && unit.kinds.length && (!artifacts.scopes || artifacts.scopes.includes(unit.renderScope.kind))) {
                dynamicUnits.add(unit.output);
              }
              const capabilities = adapter.capabilities({ binding, renderUnit: unit, observation: live,
                profile });
              inputUnits.push({ renderUnit: unit, capabilities,
                config: await resolveArtifactRenderConfig({ pluginName: plugin.manifest.name, sourceId: binding.plugin.sourceId,
                  sourceIdentity: binding.plugin.sourceIdentity, logicalIdentity: plugin.catalogLogicalIdentity,
                  manifest: plugin.manifest, platform, scope: unit.renderScope.kind,
                  cwd: unit.renderScope.kind === 'project' ? unit.renderScope.projectRoot : context.executionCwd,
                  env: context.env, referencePlugins: demand.plugins }) });
            }
            const inputEvidence = await createPlatformInputEvidence({ plugin, binding, units: inputUnits }).catch((error: unknown) => {
              rethrowFatalError(error);
              options.signal?.throwIfAborted();
              const systemCode = (error as NodeJS.ErrnoException)?.code;
              if (systemCode !== 'ENOENT' && systemCode !== 'ENOTDIR') throw error;
              observation.blockers.push({ code: 'componentResourceMissing', message: 'A required plugin source file or directory is missing.',
                subject, detail: { reasonCode: systemCode } });
              return undefined;
            });
            if (!inputEvidence) { states.push('unknown'); continue; }
            const readPackageProjection = async () => {
              const layout = await getDeploymentLayout(ctx, binding);
              const marker = await readSkillOwnerMarker({ skillRoot: layout.packageRoot, allowedRoot: path.dirname(layout.packageRoot),
                expectedIdentity: deploymentPackageComponent(binding, layout).identity });
              return { layout, projection: marker?.nativeProjection };
            };
            const packageUnit = renderUnits.find((unit) => unit.output === 'package');
            const rolePackage = (platform === 'copilot' || platform === 'grok') && packageUnit?.kinds.includes('agent')
              && dynamicUnits.has('package') && plugin.manifest.extensions?.instructions?.length
              && live.package === 'present' && live.ownership === 'aw' ? await readPackageProjection() : undefined;
            // The current package projection identifies renderer-produced roles. File presence and bytes are checked below.
            const roleProjection = rolePackage?.projection;
            const projectedRole = rolePackage && roleProjection?.preparation === 'complete'
              && roleProjection.inputDigest === platformPackageInputDigest(inputEvidence)
              && identityDigest(roleProjection.physicalIdentity) === identityDigest(rolePackage.layout.physicalIdentity)
              && roleProjection.components.some(({ nativeName, relativeOutputs }) => relativeOutputs.includes(platform === 'copilot'
                ? `com.github.copilot/agents/${nativeName}.agent.md` : `agents/${nativeName}.md`));
            let expectedCount = 0;
            let grokAgentRecipientScope: string | undefined;
            for (const { renderUnit: unit, capabilities } of inputUnits) {
              const expected = await normalizeStaticPluginComponents({ pluginRoot: plugin.rootDir, staticResourceRoot,
                manifest: plugin.manifest, platform, capabilities, allowedOutputKinds: unit.kinds,
                hasInstructionAgentRecipients: platform === 'grok' && unit.output === 'supplement'
                  ? grokAgentRecipientScope === identityDigest(unit.renderScope) : projectedRole || undefined });
              if (platform === 'grok' && unit.output === 'package'
                && (projectedRole || expected.components.some(({ kind }) => kind === 'agent'))) {
                grokAgentRecipientScope = identityDigest(unit.renderScope);
              }
              expectedCount += expected.components.length;
              for (const component of expected.components) {
                const grokRoleText = platform === 'grok' && component.kind === 'instruction' && !component.content.coverage.includes('main');
                if (unit.output === 'supplement' && !grokRoleText) staticSupplements.push(component);
                else staticPackageIds.add(component.id);
              }
              unmet.push(...expected.unmet);
            }
            const recordedDelivery = await readPlatformDeliveryState({ input: inputEvidence, env: context.env });
            const recordedGaps = recordedDelivery?.result === 'capability-gaps' && recordedDelivery.gaps.length ? recordedDelivery : undefined;
            for (const { field, ...detail } of recordedDelivery?.permissionNotices ?? []) {
              observation.reasons!.push({ code: INVOCATION_POLICY_NOT_APPLIED, subject: { ...subject, field }, detail,
                message: deliveryNoticeMessage(INVOCATION_POLICY_NOT_APPLIED, detail, field) });
            }
            const currentIds = recordedGaps ? new Set(recordedGaps.installedComponentIds) : undefined;
            if (currentIds && recordedGaps) {
              // A renderer receipt can add dynamic expectations. A positive static
              // expectation remains unless that specific component was skipped.
              const skipped = new Set(recordedGaps.gaps.filter((gap) => !gap.componentId).map((gap) => gap.id));
              for (const id of [...staticPackageIds, ...staticSupplements.map((component) => component.id)]) {
                if (!skipped.has(id)) currentIds.add(id);
              }
            }
            let packageExpectedCount = staticPackageIds.size;
            const expectedSupplements = currentIds ? staticSupplements.filter(({ id }) => currentIds.has(id)) : staticSupplements;
            const supplements = await inspectStaticSupplements(ctx, binding, expectedSupplements);
            const gaps = recordedGaps?.gaps ?? unmet;
            const blockingGaps = gaps.filter((gap) => !isDeliveryCapabilityGap(gap));
            if (gaps.length) {
              (observation.componentGaps ??= []).push(...scopeNativeComponentGaps(gaps,
                { pluginId: root.pluginId, agent: platform, scope: binding.scope.kind }, renderUnits));
            }
            const supplementInput = inputEvidence.units.find((unit) => unit.output === 'supplement');
            const recordedSupplements = dynamicUnits.has('supplement') && supplementInput
              ? await inspectPlatformSupplementState(ctx, binding, supplementInput.inputDigest) : null;
            if (recordedSupplements) {
              const staticIds = new Set(supplements.components.map((component) => component.id));
              const dynamicComponents = recordedSupplements.components.filter((component) => !staticIds.has(component.id));
              supplements.components.push(...dynamicComponents);
              expectedCount += dynamicComponents.length;
            }
            if (currentIds) {
              expectedCount = currentIds.size;
              const supplementIds = new Set(supplements.components.map(({ id }) => id));
              packageExpectedCount = [...currentIds].filter((id) => !supplementIds.has(id)).length;
            }
            const supplementConflict = supplements.components.some((component) => component.reasonCodes.includes('supplementOwnershipConflict'));
            const supplementMissing = supplements.components.some((component) => component.presence === 'absent');
            const supplementDrift = supplements.components.some((component) => component.reasonCodes.includes('componentContentDrift'));
            const supplementUnknown = supplements.components.some((component) => component.presence === 'unknown');
            const supplementInputDrift = Boolean(recordedSupplements && !recordedSupplements.inputMatches
              && recordedSupplements.components.every((component) => component.presence === 'present'));
            if (supplementConflict) block('supplementOwnershipConflict');
            if (supplementDrift) warn('platformContentDrift');
            if (supplementInputDrift) warn('platformInputDrift');
            if (supplementMissing) warn('componentOutputMissing');
            if (supplementUnknown && !supplementConflict) warn('componentOutputUnconfirmed');
            if (supplements.owned && !existing.some((target) => target.pluginId === root.pluginId && target.agent === platform && target.scope === demand.scope)) {
              owned.push({ pluginId: root.pluginId, agent: platform, scope: demand.scope });
              existing.push({ pluginId: root.pluginId, agent: platform, scope: demand.scope });
            }
            const onlyCapabilityGaps = expectedCount === 0 && gaps.length > 0 && !blockingGaps.length;
            const capabilityEmpty = onlyCapabilityGaps && recordedGaps !== undefined;
            const confirmedEmpty = capabilityEmpty || Boolean(plugin.manifest.artifacts && expectedCount === 0 && gaps.length === 0
              && recordedDelivery?.result === 'intentional-empty');
            const confirmedEmptyPackage = Boolean(currentIds?.size && !packageExpectedCount) || binding.route === 'codex-marketplace' && recordedSupplements !== null
              && dynamicUnits.has('package') && packageExpectedCount === 0
              && await matchesPlatformEmptyState({ state: { ...inputEvidence, kind: 'aw-platform-empty-state', result: 'intentional-empty',
                units: inputEvidence.units.filter((unit) => unit.output === 'package') }, env: context.env });
            const dynamicSupplementsUnconfirmed = dynamicUnits.has('supplement') && !confirmedEmpty
              && !recordedSupplements?.inputMatches && !supplementInputDrift;
            if (dynamicSupplementsUnconfirmed) warn('dynamicExpectationUnconfirmed');
            const hasPackageExpectation = packageExpectedCount > 0 || !currentIds && dynamicUnits.has('package') && !confirmedEmpty && !confirmedEmptyPackage;
            const inheritsUserNative = demand.targetRequirements?.find((item) => item.pluginId === root.pluginId
              && item.target === platform)?.inheritsUserNative;
            const requiredActivation = requiredDeploymentActivation(binding, live, !inheritsUserNative);
            for (const entry of live.diagnostics) {
              if (entry.code === 'codexProjectActivationUnconfirmed' && inheritsUserNative && requiredActivation === 'enabled') continue;
              const needsOwnership = live.ownership === 'unknown' && live.package !== 'absent' && live.registration !== 'absent';
              const destination = entry.severity === 'error' || (hasPackageExpectation || confirmedEmpty || confirmedEmptyPackage) && isNativeReadError(entry, needsOwnership)
                ? observation.blockers : observation.reasons!;
              destination.push({ code: entry.code, message: entry.message, subject: { ...subject, ...entry.subject }, detail: entry.detail });
            }
            const requiresScopeRegistration = binding.route === 'claude-marketplace' && !inheritsUserNative;
            const registration = requiresScopeRegistration ? live.scopeRegistration ?? 'unknown' : live.registration;
            const ownershipConflict = live.ownership === 'foreign' || live.ownership === 'shared';
            if (ownershipConflict) block('deploymentOwnershipConflict');
            const missing = hasPackageExpectation && (live.package === 'absent' && packageExpectedCount > 0
              || registration === 'absent' && (packageExpectedCount > 0 || live.package === 'present')
              || live.nativePackage === 'absent');
            if (missing) {
              if (live.package === 'absent') warn('platformPackageMissing');
              if (registration === 'absent') warn('nativeRegistrationMissing');
              if (live.nativePackage === 'absent') warn('nativePackageMissing');
            }
            let inputDrift = false;
            let packageExpectationConfirmed = false;
            let projectionUnconfirmed = false;
            let componentMissing = false;
            let componentUnknown = false;
            let nativeContentDrift = false;
            let nativeContentUnconfirmed = false;
            if (hasPackageExpectation && live.package === 'present' && live.ownership === 'aw' && !missing) {
              const { layout, projection } = rolePackage ?? await readPackageProjection();
              const contentDigest = projection ? await readPlatformPackageContentDigest(layout.packageRoot) : undefined;
              if (['grok-cli', 'antigravity-cli'].includes(binding.route) && live.registration === 'present') {
                nativeContentUnconfirmed = !contentDigest || !live.nativePackageContentDigest;
                nativeContentDrift = Boolean(contentDigest && live.nativePackageContentDigest
                  && contentDigest !== live.nativePackageContentDigest);
                if (nativeContentUnconfirmed) warn('nativePackageContentUnconfirmed');
                if (nativeContentDrift) warn('nativePackageContentDrift');
              }
              projectionUnconfirmed = !projection || projection.preparation !== 'complete' || !contentDigest;
              const packageInputDigest = platformPackageInputDigest(inputEvidence);
              inputDrift = Boolean(projection && (projection.inputDigest !== packageInputDigest
                || contentDigest && projection.contentDigest !== contentDigest));
              if (projectionUnconfirmed) warn(projection?.preparation === 'partial'
                ? 'platformPreparationPartial' : 'platformExpectationUnconfirmed');
              else if (inputDrift) warn(projection!.inputDigest !== packageInputDigest
                ? 'platformInputDrift' : 'platformContentDrift');
              componentMissing = live.components.some((component) => component.presence === 'absent');
              componentUnknown = live.components.some((component) => component.presence === 'unknown'
                && !component.reasonCodes.includes('nativePackageContentDrift'));
              if (componentMissing) warn('componentOutputMissing');
              if (componentUnknown && !nativeContentUnconfirmed) warn('componentOutputUnconfirmed');
              packageExpectationConfirmed = Boolean(!projectionUnconfirmed && projection!.inputDigest === packageInputDigest
                && projection!.components.length > 0);
              if (packageExpectationConfirmed) {
                expectedCount = Math.max(expectedCount, projection!.components.length);
                if (platform === 'pi' && !inputDrift) {
                  const roles = projection!.components.filter((component) => component.relativeOutputs.some((output) => /^agents\/[^/]+\.md$/u.test(output))
                    && live.components.some((entry) => entry.id === component.id && entry.presence === 'present' && !entry.reasonCodes.length));
                  const warning = piAgentConsumerDiagnostic(binding, live, roles.map(({ id }) => id));
                  if (warning) observation.reasons!.push(warning);
                }
              }
            }
            const confirmedPackage = packageExpectationConfirmed && !inputDrift && !nativeContentDrift && !nativeContentUnconfirmed;
            const confirmedComponents = [...(confirmedPackage ? live.components : []), ...supplements.components];
            for (const component of confirmedComponents) {
              if (component.presence === 'present' && !component.reasonCodes.length && (!currentIds || currentIds.has(component.id))) {
                deliveredIds.add(component.id);
              }
            }
            live.components.push(...supplements.components);
            currentMatches.push(Boolean(currentIds) || !dynamicUnits.size || confirmedEmpty || packageExpectationConfirmed || missing
              || recordedSupplements !== null && !hasPackageExpectation);
            emptyMatches.push(confirmedEmpty && !capabilityEmpty);
            for (const entry of blockingGaps) block(entry.reasonCode);

            const inactiveScope = live.registration === 'absent'
              || live.package === 'absent' && live.registration === 'not-applicable'
              || live.scopeRegistration === 'absent'
              || binding.scope.kind === 'project' && shared && live.configuration?.activation === 'absent'
              || live.consumers.every((consumer) => ['disabled', 'not-applicable'].includes(consumer.activation));
            const skippedFiles = gaps.filter((gap) => supplementInput?.kinds.includes(gap.kind) && gap.name
              && !currentIds?.has(gap.componentId ?? gap.id)
              && !expectedSupplements.some((component) => component.kind === gap.kind && component.name === gap.name));
            if (skippedFiles.length) {
              const slots = gapSupplementFiles(binding, await getDeploymentLayout(ctx, binding), skippedFiles);
              const checked = await inspectOwnedComponents({ components: slots });
              const retained = checked.components.filter((item) => item.state !== 'absent');
              if (retained.length) {
                for (const item of retained) if ('path' in item.component) {
                  observation.blockers.push(retainedOutputDiagnostic(root.pluginId, platform, binding.scope.kind, item.component.path));
                }
                states.push(retained.some((item) => item.state === 'foreign') ? 'conflict'
                  : retained.some((item) => item.state === 'error') ? 'unknown' : 'drifted');
                continue;
              }
            }
            if (onlyCapabilityGaps) {
              const supplementKey = supplementInput?.physicalKey;
              const retained = supplementKey ? inventory.flatMap(({ ownedComponent }) =>
                ownedComponent?.kind === 'owned-text-file' && ownedComponent.identity.physicalKey === supplementKey
                  && ownedComponent.identity.sourceIdentity === binding.plugin.sourceIdentity && ownedComponent.identity.pluginId === root.pluginId
                  ? [ownedComponent.path] : []) : [];
              const piRegistrationRemaining = binding.route === 'pi-package'
                && (live.registration === 'present' || live.configuration?.activation === 'enabled');
              if ((live.package === 'present' && (!shared || !inactiveScope) || piRegistrationRemaining) && live.nativeIdentity) {
                retained.push(live.nativeIdentity.sourceLocation);
              }
              if (binding.route === 'cursor-workspace-hook' && live.workspaceOpen === 'present') {
                retained.push((await getDeploymentLayout(ctx, binding)).activationPath);
              }
              if (retained.length) {
                observation.blockers.push(...retained.map((file) => retainedOutputDiagnostic(root.pluginId, platform, binding.scope.kind, file)));
                states.push(ownershipConflict ? 'conflict' : 'drifted');
                continue;
              }
            }
            if (confirmedEmpty) {
              const hiddenEmptyPi = capabilityEmpty && piProjectEmptyDeliveryObserved(binding, live);
              const cursorHookUnconfirmed = capabilityEmpty && binding.route === 'cursor-workspace-hook' && live.workspaceOpen !== 'absent';
              const piConfigUnconfirmed = capabilityEmpty && binding.route === 'pi-package' && live.configuration?.activation !== 'absent';
              states.push(ownershipConflict ? 'conflict' : live.package === 'unknown' || live.registration === 'unknown' && !hiddenEmptyPi
                || live.ownership === 'unknown' || observation.blockers.length || cursorHookUnconfirmed || piConfigUnconfirmed || !inactiveScope && !hiddenEmptyPi ? 'unknown'
                : live.package === 'absent' || shared ? 'satisfied' : 'drifted');
              continue;
            }
            if (hasPackageExpectation && !missing) {
              if (registration === 'unknown') warn('nativeRegistrationUnconfirmed');
              if (requiredActivation === 'unknown') warn('nativeActivationUnconfirmed');
              if (requiredActivation === 'disabled') warn('nativeActivationDisabled');
              if (requiredActivation === 'blocked') block(binding.route === 'grok-directory'
                ? 'grokProjectAuthorizationDenied' : 'nativeActivationBlocked');
              if (binding.route === 'cursor-workspace-hook') {
                if (live.workspaceOpen === 'absent') warn('cursorWorkspaceOpenMissing');
                if (live.workspaceOpen === 'unknown') warn('cursorWorkspaceOpenUnconfirmed');
              }
            }
            if (ownershipConflict || supplementConflict) states.push('conflict');
            else if (confirmedEmptyPackage && (live.package === 'unknown' || live.registration === 'unknown' || live.ownership === 'unknown')) states.push('unknown');
            else if (confirmedEmptyPackage && (!inactiveScope || !shared && live.package === 'present')) {
              warn('platformContentDrift');
              states.push('drifted');
            }
            else if (onlyCapabilityGaps) {
              warn('platformExpectationUnconfirmed');
              states.push('unknown');
            }
            else if (blockingGaps.length || hasPackageExpectation && registration === 'unknown') states.push('unknown');
            else if (missing) states.push('absent');
            else if (supplementUnknown || hasPackageExpectation && (live.package === 'unknown' || live.ownership === 'unknown'
              || requiredActivation === 'unknown' || live.workspaceOpen === 'unknown'
              || componentUnknown || nativeContentUnconfirmed || projectionUnconfirmed)) states.push('unknown');
            else if (componentMissing || supplementMissing && !dynamicSupplementsUnconfirmed) states.push('absent');
            else if (hasPackageExpectation && ['disabled', 'blocked'].includes(requiredActivation)
              || live.workspaceOpen === 'absent' && live.package === 'present' || inputDrift || supplementDrift || supplementInputDrift || nativeContentDrift) states.push('drifted');
            else if (dynamicSupplementsUnconfirmed || hasPackageExpectation && !packageExpectationConfirmed) states.push('unknown');
            else if (!expectedCount) states.push(live.package === 'absent' && ['absent', 'not-applicable'].includes(live.registration) ? 'satisfied' : 'drifted');
            else states.push('satisfied');
          }
          observation.intentionalEmpty = emptyMatches.length === resolution.bindings.length && emptyMatches.every(Boolean);
          observation.expectationConfirmed = currentMatches.length === resolution.bindings.length && currentMatches.every(Boolean);
          if (versions.length && versions[0] && versions.every((version) => version === versions[0])) observation.installedVersion = versions[0];
          observation.content = (['conflict', 'drifted', 'absent', 'unknown'] as const)
            .find((state) => states.includes(state)) ?? 'satisfied';
          if (observation.content === 'satisfied' || observation.content === 'absent' || deliveredIds.size) {
            observation.installedComponentIds = [...deliveredIds];
          }
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
      await ownedSession?.dispose();
    }
    return { observations, existing, owned };
  }, { signal: options.signal });
  return { observations: platforms.flatMap((result) => result.observations),
    existing: platforms.flatMap((result) => result.existing), owned: platforms.flatMap((result) => result.owned) };
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
          if (native.componentGaps?.length) target.componentGaps = native.componentGaps;
          if (native.installedComponentIds) {
            target.installedComponentIds = native.installedComponentIds;
            target.installedComponentCount = native.installedComponentIds.length;
          }
          if (native.installedVersion) target.installedVersion = native.installedVersion;
          if (native.deploymentObservations) target.deploymentObservations = native.deploymentObservations;
          if (native.deploymentExclusions) target.deploymentExclusions = native.deploymentExclusions;
          target.blockers.push(...native.blockers);
          if (native.reasons?.length) target.reasons = [...native.reasons];
          errors.push(...native.blockers.filter((entry) => isNativeReadError(entry))
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
            excludedPluginIds: demand.userProviders?.[agent] }, options.catalogReadScope);
          options.signal?.throwIfAborted();
          target.blockers.push(...portable.blockers.filter((code) => code !== 'previousDeploymentRetained').map((code) => portablePreparationDiagnostic(portable, diagnostic(code),
            agent as import('../portable/recovery-layout.js').PortableAgent)));
          if (portable.policyNotices?.length) target.reasons = [...target.reasons ?? [], ...portable.policyNotices];
          const gaps = (portable.unmet ?? []).filter((gap) => gap.agent === agent);
          const blockingGap = gaps.some((gap) => !isDeliveryCapabilityGap(gap));
          if (gaps.length) target.componentGaps = gaps;
          if (blockingGap && !target.blockers.some((entry) => entry.code === 'portableComponentsUnmet')) target.blockers.push(diagnostic('portableComponentsUnmet'));
          const observed = portable.targets.filter((entry) => entry.agent === agent);
          if (!portable.globalBlockers?.length) {
            const installed = observed.filter((entry) => entry.providerPluginId === root.pluginId
              && entry.disposition === 'write' && entry.observation === 'satisfied' && !entry.blocker);
            if (installed.length || observed.every((entry) => entry.disposition === 'retain'
              || entry.observation === 'satisfied' || entry.observation === 'absent')) {
              target.installedComponentCount = installed.length;
              if (installed.every((entry) => entry.componentId)) target.installedComponentIds = installed.map((entry) => entry.componentId!);
            }
          }
          target.blockers.push(...observed.flatMap((entry) => entry.disposition === 'retain'
            ? [retainedOutputDiagnostic(entry.providerPluginId, agent, options.scope, entry.physicalPath, `skill.${entry.skill}`)]
            : entry.blocker ? [diagnostic(entry.blocker)] : []));
          target.content = (['conflict', 'drifted', 'absent', 'unknown'] as const)
            .find((state) => observed.some((entry) => entry.observation === state))
            ?? (!portable.blockers.length && (observed.length || portable.intentionalEmpty || gaps.length && !blockingGap) ? 'satisfied' : 'unknown');
          if (observed.length === 0 && portable.blockers.includes('needs-preparation') && options.portableCoverage === true
            && options.portableInstalled && !options.portableInstalled.some((item) => item.pluginId === root.pluginId && item.agent === agent)) {
            target.content = 'absent'; target.blockers = target.blockers.filter((item) => item.code !== 'needs-preparation');
          }
          if ((blockingGap || observed.some((entry) => entry.disposition === 'retain')) && target.content !== 'conflict') target.content = 'unknown';
          target.backend = observed.map((entry) => ({ skill: entry.skill, agent: entry.agent,
            ownership: entry.ownership, observation: entry.observation, associatedAgents: entry.associatedAgents }));
          if (target.blockers.some(isTargetObservationReadError)) {
            errors.push({ ...diagnostic('portableObservationFailed'), pluginId: root.pluginId });
          }
        } catch (error) {
          rethrowFatalError(error);
          options.signal?.throwIfAborted();
          target.blockers.push(diagnostic('portableObservationFailed'));
          errors.push({ ...diagnostic('portableObservationFailed'), pluginId: root.pluginId });
        }
      }
      const dynamicExpectationConfirmed = delivery?.kind === 'native' && options.nativeObservations.some((entry) =>
        entry.pluginId === root.pluginId && entry.platform === delivery.platform && (entry.intentionalEmpty === true || entry.expectationConfirmed === true));
      if (delivery?.kind === 'native' && root.plugin?.manifest.artifacts && !dynamicExpectationConfirmed) {
        if (target.content === 'satisfied' || target.content === 'absent') target.content = 'unknown';
        if (target.content === 'unknown' && !target.reasons?.some((entry) => entry.code === 'dynamicExpectationUnconfirmed')) {
          target.reasons = [...target.reasons ?? [], diagnostic('dynamicExpectationUnconfirmed')];
        }
      }
      if (target.content === 'satisfied' && !target.blockers.length && target.installedComponentCount === 0
        && target.componentGaps?.some((gap) => gap.providerPluginId === target.pluginId) && target.componentGaps.every(isDeliveryCapabilityGap)) {
        target.satisfaction = 'not-applicable';
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
      catalogOperationContext: options.catalogOperationContext, signal: options.signal, catalogReadScope: options.catalogReadScope });
    options.signal?.throwIfAborted();
    options.onDemand?.(demand);
    options.signal?.throwIfAborted();
    const ownerInventory = options.nativeObservations ? { references: [], errors: [] }
      : await measureRecoveryPerformanceStage(options, 'status.inventory', () => inventoryCatalogSourceReferences({ cwd: context.executionCwd, env: context.env, scope: options.scope,
        knownPluginNames: demand.plugins.map((plugin) => plugin.manifest.name), collectPathEvidence: false,
        observationPlugins: options.observationPlugins }));
    options.signal?.throwIfAborted();
    const candidates = ownerInventory.references.filter((entry) => entry.scope === options.scope
      && entry.sourceId && entry.pluginName && isPlatformTarget(entry.platform) && entry.platform !== 'generic'
      && (!options.observationPlugins || options.observationPlugins.has(`${entry.sourceId}/${entry.pluginName}`)
        || options.observationPlugins.has(entry.pluginName))
      && (!options.targets || options.targets.includes(entry.platform)));
    const observedPlugins = new Map(demand.plugins.map((plugin) => [plugin.pluginId, plugin]));
    const catalog = demand.catalogOperationContext ?? options.catalogOperationContext;
    const catalogSources = options.catalogSources ?? new Map<string, CatalogOperationContext['catalog']['sources'][number]>();
    for (const source of catalog?.catalog.sources ?? []) if (!catalogSources.has(source.sourceId)) catalogSources.set(source.sourceId, source);
    if (candidates.some((entry) => !observedPlugins.has(`${entry.sourceId}/${entry.pluginName}`))) {
      try {
        const missing = [...new Set(candidates.map((entry) => entry.sourceId!))].filter((id) => !catalogSources.has(id));
        if (missing.length) {
          const config = await readCatalogSourcesConfigSnapshot(context.env);
          const configured = new Set(config.config.sources.map((source) => source.id));
          const sourceIds = missing.filter((id) => configured.has(id));
          if (sourceIds.length) {
            const additional = await resolvePartialCatalogOperationContext({ env: context.env, signal: options.signal,
              configSnapshot: config, sourceIds }, options.catalogReadScope);
            for (const source of additional.catalog.sources) catalogSources.set(source.sourceId, source);
          }
        }
      }
      catch (error) {
        rethrowFatalError(error);
        options.signal?.throwIfAborted();
      }
      for (const candidate of candidates) {
        const pluginId = `${candidate.sourceId}/${candidate.pluginName}`;
        if (observedPlugins.has(pluginId)) continue;
        const source = catalogSources.get(candidate.sourceId!)?.resolution;
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
      : await withStatusNativeQueries({ ...options, targets: [...new Set([...selectedAgents, ...candidates.map((entry) => entry.platform!)])] },
        (nativeOptions) => readAdapterObservations(nativeOptions, context, observationDemand, candidates));
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
    const inventoryOwned = candidates.flatMap((entry) => {
      // A verified Antigravity copy remains a native retirement candidate when
      // its AW source is gone. Execution still verifies the live registration;
      // the copy is not an owned filesystem output or AW source authority.
      const nativeCopy = entry.platform === 'antigravity' && entry.scope === 'user'
        && entry.kind === 'namespacedMarketplace' && entry.recoveryCandidate?.evidence === 'verified'
        && entry.recoveryCandidate.binding.route === 'antigravity-cli';
      return nativeCopy || entry.ownedComponent && !['codex', 'claude', 'copilot'].includes(entry.platform!)
        ? [{ pluginId: `${entry.sourceId}/${entry.pluginName}`, agent: entry.platform as PlatformName, scope: options.scope }] : [];
    });
    for (const entry of inventoryOwned) {
      if (!expected(entry.pluginId, entry.agent) && !nativeExtraObserved.some((target) => target.pluginId === entry.pluginId && target.agent === entry.agent)) {
        nativeExtraObserved.push({ ...entry, delivery: { kind: 'native', platform: entry.agent }, observation: 'unknown', content: 'unknown' });
      }
    }
    for (const entry of candidates) {
      const component = entry.ownedComponent;
      if (component?.kind !== 'owned-directory' || !['codex', 'claude', 'copilot'].includes(entry.platform!)
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
    const portableExtra = options.targets && !options.targets.includes('generic') ? { targets: [], complete: true }
      : await inspectPortableExtraInstalled({
        scope: options.scope, context, env: context.env, signal: options.signal, plugins: options.observationPlugins,
      });
    options.signal?.throwIfAborted();
    const portableObserved: RecoveryStatus['extraObserved'] = portableExtra.targets
      .filter((entry) => !expected(entry.pluginId, entry.agent))
      .map((entry) => ({ pluginId: entry.pluginId, agent: entry.agent, scope: options.scope,
        delivery: { kind: 'agent-skills', provider: 'aw', agentId: 'generic' },
        observation: entry.observation, content: entry.content,
        backend: { skill: entry.skill, logicalIdentity: entry.logicalIdentity } }));
    const extraObserved = [...nativeExtraObserved, ...portableObserved];
    const relevantErrors = ownerInventory.errors.filter((error) => {
      const relevance = error.relevance;
      if (relevance.global) return true;
      if (options.targets && relevance.platform && !options.targets.includes(relevance.platform)) return false;
      if (!options.observationPlugins) return true;
      if (!relevance.pluginName && !relevance.sourceId) return true;
      return [...options.observationPlugins].some((id) => {
        const parsed = parsePluginId(id);
        const plugin = observedPlugins.get(id);
        return (!relevance.sourceId || !parsed.sourceId || relevance.sourceId === parsed.sourceId)
          && (!relevance.pluginName || relevance.pluginName === parsed.pluginName
            || relevance.componentName && plugin?.manifest.extensions?.agents?.some((agent) => agent.name === relevance.componentName));
      });
    });
    const result = await statusFromObservations({ ...options, context, demand,
      nativeObservations: options.nativeObservations ?? adapters.observations, extraObserved,
      portableCoverage: portableExtra.complete, portableInstalled: portableExtra.targets,
      nativeReadErrors: [
        ...relevantErrors.map(inventoryRecoveryDiagnostic),
        ...adapters.observations.flatMap((entry) => entry.blockers.filter((error) => isNativeReadError(error))),
      ] });
    result.coverage.requestComplete = result.coverage.native && result.coverage.portable;
    result.coverage.native &&= ownerInventory.errors.length === 0;
    // The project scan includes User Intent. Demand accounts for its effect on
    // shared providers, while this loop attributes failures to local outputs.
    const userIntentPath = options.scope === 'project' && relevantErrors.some((error) => error.kind === 'lifecycleIntentRead')
      ? await resolveIntentPath({ ...options, scope: 'user' }) : undefined;
    const targetErrors = relevantErrors.filter((error) => !(userIntentPath && error.kind === 'lifecycleIntentRead'
      && error.recoveryPath === userIntentPath));
    for (const target of result.inventory?.flatMap((entry) => entry.targetResults) ?? []) {
      for (const error of targetErrors) {
        const relevance = error.relevance;
        const identity = parsePluginId(target.pluginId);
        if (!relevance.global && (relevance.platform && relevance.platform !== target.agent
          || relevance.sourceId && relevance.sourceId !== identity.sourceId
          || relevance.scope && relevance.scope !== target.scope
            && !(relevance.scope === 'user' && target.scope === 'project' && ['codex', 'claude', 'copilot'].includes(target.agent))
          || relevance.projectLocationKey && relevance.projectLocationKey !== context.projectKey
          || relevance.pluginName && relevance.pluginName !== identity.pluginName
            && !(relevance.componentName && observedPlugins.get(target.pluginId)?.manifest.extensions?.agents?.some((agent) => agent.name === relevance.componentName)))) continue;
        target.blockers.push(inventoryRecoveryDiagnostic(error));
        if (target.content === 'satisfied') { target.content = 'unknown'; target.observation = 'unknown'; }
      }
    }
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

function observedSatisfaction(content: RecoveryTarget['content'], provider: RecoveryTarget | undefined,
  inheritsUser: boolean): NonNullable<RecoveryTarget['satisfaction']> {
  if (!content || content === 'unknown') return 'unknown';
  if (content !== 'satisfied') return 'pending';
  if (provider?.satisfaction === 'not-applicable') return 'not-applicable';
  return inheritsUser ? 'inherited-user' : 'installed';
}

export function aggregateConvergence(allSatisfied: boolean | null, residue: 'present' | 'absent' | 'unknown'): boolean | null {
  return allSatisfied === false || residue === 'present' ? false
    : allSatisfied === null || residue === 'unknown' ? null : true;
}

export async function readRecoveryStatus(options: ReadRecoveryStatusOptions & {
  onDemand?: (demand: DemandSnapshot) => string[] | undefined;
  onNativeStatus?: (status: RecoveryStatus, demand: DemandSnapshot) => void | Promise<void>;
}, preparedDemand?: JointDemandSnapshot): Promise<RecoveryStatus> {
  return withStatusNativeQueries(options, (nativeOptions) => readRecoveryStatusWithQueries(nativeOptions, preparedDemand));
}

async function readRecoveryStatusWithQueries(options: ReadRecoveryStatusOptions & {
  onDemand?: (demand: DemandSnapshot) => string[] | undefined;
  onNativeStatus?: (status: RecoveryStatus, demand: DemandSnapshot) => void | Promise<void>;
}, preparedDemand?: JointDemandSnapshot): Promise<RecoveryStatus> {
  options = { ...options, discoveryCache: options.discoveryCache ?? new Map(), catalogSources: new Map() };
  const snapshot = preparedDemand ?? await measureRecoveryPerformanceStage(options, 'status.demand', () => readJointDemand(options));
  if (options.codexObservationSession || options.nativeObservations || options.targets && !options.targets.includes('codex')) {
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

/** An empty demand or inventory does not establish that the selected Catalog is readable. */
async function checkUndeclaredSelection(options: ReadRecoveryStatusOptions, snapshot: JointDemandSnapshot): Promise<RecoveryDiagnostic[]> {
  const demands = [snapshot.user, ...(snapshot.project ? [snapshot.project] : [])];
  const known = new Set(demands.flatMap((demand) => demand.plugins.map((plugin) => plugin.pluginId!)));
  const selectors = (options.plugins ?? []).filter((selector) => ![...known].some((id) =>
    id === selector || !selector.includes('/') && parsePluginId(id).pluginName === selector));
  if (!selectors.length) return [];
  const sources = options.catalogSources ?? new Map<string, CatalogOperationContext['catalog']['sources'][number]>();
  for (const source of [options.catalogOperationContext, ...demands.map((demand) => demand.catalogOperationContext)]
    .flatMap((context) => context?.catalog.sources ?? [])) if (!sources.has(source.sourceId)) sources.set(source.sourceId, source);
  const errors: RecoveryDiagnostic[] = [];
  try {
    const config = await readCatalogSourcesConfigSnapshot(options.env);
    const configured = new Set(config.config.sources.map((source) => source.id));
    const wanted = new Set(selectors.flatMap((selector) => parsePluginId(selector).sourceId
      ? [parsePluginId(selector).sourceId!] : [...configured]));
    const missing = [...wanted].filter((id) => configured.has(id) && !sources.has(id));
    if (missing.length) {
      const context = await resolvePartialCatalogOperationContext({ sourceIds: missing, configSnapshot: config,
        env: options.env, signal: options.signal }, options.catalogReadScope);
      for (const source of context.catalog.sources) sources.set(source.sourceId, source);
    }
    for (const selector of selectors) {
      const { sourceId, pluginName } = parsePluginId(selector);
      const candidates = sourceId ? [sourceId] : [...configured];
      const code = sourceId && !configured.has(sourceId) ? 'sourceMissing'
        : candidates.some((id) => !sources.get(id)?.resolution) ? 'sourceActiveUnavailable'
          : !candidates.some((id) => sources.get(id)?.resolution?.manifest.entries.some((entry) => entry.name === pluginName))
            ? 'pluginUnavailable' : undefined;
      if (code) errors.push({ code, message: 'The selected plugin or its Catalog source could not be confirmed.',
        ...(sourceId ? { pluginId: selector, subject: { pluginId: selector, sourceId } } : {}) });
    }
  } catch (error) {
    rethrowFatalError(error);
    options.signal?.throwIfAborted();
    errors.push({ code: 'catalogReadFailed', message: 'The selected Catalog source could not be read.' });
  }
  return errors;
}

async function readRecoveryStatusInSession(options: ReadRecoveryStatusOptions & {
  onDemand?: (demand: DemandSnapshot) => string[] | undefined;
  onNativeStatus?: (status: RecoveryStatus, demand: DemandSnapshot) => void | Promise<void>;
}, snapshot: JointDemandSnapshot): Promise<RecoveryStatus> {
  const selectionErrors = await checkUndeclaredSelection(options, snapshot);
  const globalPlan = deriveJointDemand(snapshot);
  const plan = options.targets ? deriveJointDemand({ ...snapshot, preferences: snapshot.preferences
    ? { ...snapshot.preferences, targets: [...new Set([...snapshot.preferences.targets, ...options.targets as AgentId[]])] } : null }) : globalPlan;
  const matchesPlugin = (id: string): boolean => !options.plugins?.length || options.plugins.some((selector) =>
    selector === id || !selector.includes('/') && parsePluginId(id).pluginName === selector);
  const selected = Boolean(options.plugins?.length || options.targets);
  const observationPlugins = options.plugins?.length ? new Set(plan.placements.filter((item) => matchesPlugin(item.pluginId)
    || item.contributions.some((contribution) => matchesPlugin(contribution.root))).map((item) => item.pluginId)) : undefined;
  if (observationPlugins) {
    const plugins = [...new Map([snapshot.user, ...(snapshot.project ? [snapshot.project] : [])]
      .flatMap((demand) => demand.plugins).map((plugin) => [plugin.pluginId!, plugin])).values()];
    for (const id of observationPlugins) {
      const plugin = plugins.find((entry) => entry.pluginId === id);
      if (!plugin) continue;
      for (const dependency of plugin.manifest.dependencies ?? []) observationPlugins.add(`${plugin.sourceId}/${dependency}`);
      const slots = new Set(plugin.manifest.extensions?.agents?.map((agent) => agent.name) ?? []);
      for (const candidate of plugins) if (candidate.manifest.extensions?.agents?.some((agent) => slots.has(agent.name))) {
        observationPlugins.add(candidate.pluginId!);
      }
    }
  }
  if (observationPlugins) for (const plugin of options.plugins ?? []) observationPlugins.add(plugin);
  const selectedPlacement = (item: (typeof plan.placements)[number]): boolean =>
    (!options.targets || options.targets.includes(item.target)) && (!observationPlugins || observationPlugins.has(item.pluginId));
  const scopes = [snapshot.user, ...(snapshot.project ? [snapshot.project] : [])];
  const observed: RecoveryStatus[] = [];
  // Scope order gives User discovery the neutral cwd before equivalent Project
  // probes reuse it. Codex also shares a mutable manager and neutral inventory.
  for (const demand of scopes) {
    const nodes = plan.placements.filter((item) => selectedPlacement(item) && (item.scope === demand.scope
      || demand.scope === 'project' && ['codex', 'claude', 'copilot'].includes(item.target)
        && item.contributions.some((contribution) => contribution.scope === 'project')));
    const expanded: DemandSnapshot = { ...demand,
      plugins: [...new Map([...demand.plugins, ...nodes.map((item) => item.plugin)]
        .map((plugin) => [plugin.pluginId, plugin])).values()],
      catalogOperationContext: demand.catalogOperationContext ?? snapshot.user.catalogOperationContext
        ?? snapshot.project?.catalogOperationContext,
      userProviders: demand.scope === 'project' ? Object.fromEntries((snapshot.preferences?.targets ?? []).map((target) => [target,
        plan.placements.filter((item) => item.scope === 'user' && item.target === target
          && !nodes.some((project) => project.scope === 'project' && project.pluginId === item.pluginId && project.target === item.target)).map((item) => item.pluginId)])) : {},
      targetRequirements: nodes.map((item) => ({ pluginId: item.pluginId, target: item.target,
        ...(item.scope === 'user' && demand.scope === 'project' ? { inheritsUserNative: true } : {}) })),
      roots: demand.roots === null ? null : [...new Map(nodes.map((item) => [item.pluginId, {
      pluginId: item.pluginId, sourceId: item.plugin.sourceId!, sourceState: 'ready' as const,
      blockers: [], plugin: item.plugin,
    }])).values()] };
    observed.push(await readScopedRecoveryStatus({ ...options, onNativeStatus: undefined, scope: demand.scope,
      cwd: snapshot.context.projectRoot ?? options.cwd, observationPlugins, targets: options.targets, demandOverride: expanded }));
  }
  const allTargets = observed.flatMap((status) => status.inventory?.flatMap((item) => item.targetResults) ?? []).map((target) => {
    const providers = plan.placements.filter((placement) => placement.pluginId === target.pluginId && placement.target === target.agent
      && (placement.scope === target.scope || target.scope === 'project'
        && ['codex', 'claude', 'copilot'].includes(target.agent) && placement.scope === 'user'
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
          if (!provider) return undefined;
          // These observations check the same physical package and the demand's own effective scope.
          const scope = hasSharedUserPackage(requirement.target) ? demand.scope : provider.scope;
          return allTargets.find((item) => item.pluginId === id && item.agent === requirement.target && item.scope === scope);
        });
        const ownProvider = providers.find((provider) => provider?.pluginId === root.pluginId);
        if (ownProvider?.installedComponentIds) target.installedComponentIds = ownProvider.installedComponentIds;
        if (ownProvider?.installedComponentCount !== undefined) target.installedComponentCount = ownProvider.installedComponentCount;
        if (ownProvider?.installedVersion) target.installedVersion = ownProvider.installedVersion;
        target.blockers.push(...providers.flatMap((item) => item?.blockers ?? []));
        const reasons = providers.flatMap((item) => item?.reasons ?? []);
        if (reasons.length) target.reasons = reasons;
        const componentGaps = providers.flatMap((item) => item?.componentGaps ?? []);
        if (componentGaps.length) target.componentGaps = uniqueRecoveryComponentGaps(componentGaps);
        const exclusions = providers.flatMap((item) => item?.deploymentExclusions ?? []);
        if (exclusions.length) target.deploymentExclusions = [...new Map(exclusions.map((exclusion) =>
          [JSON.stringify([exclusion.pluginId, exclusion.platform, exclusion.scope, exclusion.productId, exclusion.reasonCode]), exclusion])).values()];
        const deployments = providers.flatMap((item) => item?.deploymentObservations ?? []);
        if (deployments.length) target.deploymentObservations = [...new Map(deployments.map((item) => [item.bindingId, item])).values()];
        target.content = (['conflict', 'drifted', 'absent', 'unknown'] as const).find((state) => providers.some((item) => (item?.content ?? 'unknown') === state)) ?? 'satisfied';
        target.observation = target.content === 'satisfied' ? 'verified' : target.content === 'absent' ? 'missing' : 'unknown';
        target.satisfaction = observedSatisfaction(target.content, ownProvider, demand.scope === 'project' && placement?.scope === 'user');
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
  const globalTargets = targets.filter((target) => globalPlan.roots.some((root) => root.pluginId === target.pluginId && root.target === target.agent && root.scope === target.scope));
  const fullObservation = !selected || globalPlan.placements.every(selectedPlacement);
  const knownFailure = globalPlan.errors.some((error) => ['targetsNotConfigured', 'dependencyExcluded', 'dependencyContractInvalid', 'targetPlacementConflict'].includes(error.code))
    || globalTargets.some((target) => ['absent', 'drifted', 'conflict'].includes(target.content ?? 'unknown')
      || target.blockers.some((entry) => entry.code === 'awCapabilityUnsupported'));
  const uncertain = !fullObservation || !globalPlan.complete || globalTargets.some((target) => target.content === 'unknown' || target.blockers.length > 0);
  const allSatisfied = knownFailure ? false : uncertain ? null : true;
  const nativeCoverage = !selected && observed.every((status) => status.coverage.native);
  const portableCoverage = !selected && observed.every((status) => status.coverage.portable);
  const errors = [...new Map([...selectionErrors, ...plan.errors.filter((error) => !selected || !error.pluginId
    || !observationPlugins || observationPlugins.has(error.pluginId)), ...observed.flatMap((status) => status.errors)]
    .map((error) => [JSON.stringify(error), error])).values()];
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
  if (options.plugins?.length) {
    for (const target of allTargets.filter((target) => matchesPlugin(target.pluginId))) {
      if (visibleInventory.some((entry) => entry.pluginId === target.pluginId)) continue;
      visibleInventory.push({ pluginId: target.pluginId, source: parsePluginId(target.pluginId).sourceId!, sourceState: 'ready', blockers: [],
        targetResults: allTargets.filter((entry) => entry.pluginId === target.pluginId).map((entry) => ({ ...entry,
          requirementScope: entry.contributions?.[0]?.scope,
          satisfaction: observedSatisfaction(entry.content, entry,
            entry.scope === 'user' && entry.contributions.some((contribution) => contribution.scope === 'project')) })) });
    }
  }
  if (selected) {
    result.inventory = result.inventory?.filter((entry) => matchesPlugin(entry.pluginId)).map((entry) => ({ ...entry,
      targetResults: entry.targetResults.filter((target) => !options.targets || options.targets.includes(target.agent)) })) ?? null;
    const requested = result.inventory?.flatMap((entry) => entry.targetResults) ?? [];
    result.coverage.requestComplete = observed.every((status) => status.coverage.requestComplete ?? (status.coverage.native && status.coverage.portable))
      && result.errors.length === 0 && result.inventory !== null
      && result.inventory.every((entry) => entry.sourceState === 'ready' && entry.blockers.length === 0)
      && allTargets.every((target) => target.content !== 'unknown'
        && target.blockers.every((blocker) => blocker.code === 'needs-preparation' && ['absent', 'drifted'].includes(target.content ?? '')))
      && requested.every((target) => target.content !== 'unknown');
    result.counts = { blocked: requested.filter((target) => target.blockers.length).length,
      pending: requested.filter((target) => target.satisfaction === 'pending').length,
      unconfirmed: requested.filter((target) => target.content === 'unknown').length,
      ready: requested.filter((target) => target.content === 'satisfied').length };
  }
  await options.onNativeStatus?.(result, snapshot.context.context === 'project' ? snapshot.project! : snapshot.user);
  options.signal?.throwIfAborted();
  return result;
}
