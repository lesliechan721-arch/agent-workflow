import type { ComponentKind, PluginComponent, PlatformId, PlatformCapabilitiesV1, ResolvedInvocationPolicy, ExpectedComponentSet, ComponentGap } from '@lesliechan721/aw-plugin-core/manifest';
import type { Diagnostic, ProductInstallation, DiscoveryResult, ReadContext } from './discovery.js';
import type { VerifiedResourceClosure } from '../utils/component-resources.js';
export type { PlatformId, ComponentKind, ExpectedComponentSet, ComponentGap, ResolvedInvocationPolicy } from '@lesliechan721/aw-plugin-core/manifest';
export type { Diagnostic, ProductInstallation, HostEntry, DiscoveryResult, ReadContext, Availability } from './discovery.js';
export type { VerifiedResourceClosure } from '../utils/component-resources.js';


export type ScopeRef = { kind: 'user' } | { kind: 'project'; projectRoot: string };

export interface PluginIdentity {
  sourceId: string;
  sourceIdentity: string;
  pluginId: string;
  version: string;
}


export interface DeploymentBinding {
  id: string;
  plugin: PluginIdentity;
  platform: PlatformId;
  scope: ScopeRef;
  route: InstallRoute;
  consumers: ProductInstallation[];
  physicalKey: string;
  activationKey: string;
  renderUnitIds: string[];
}
export interface RenderUnit {
  id: string;
  physicalKey: string;
  renderScope: ScopeRef;
  output: 'package' | 'supplement' | 'generic';
  kinds: ComponentKind[];
  consumers: ProductInstallation[];
}
export type InstallRoute =
  | 'codex-marketplace' | 'claude-marketplace' | 'cursor-workspace-hook'
  | 'antigravity-cli' | 'antigravity-directory' | 'opencode-directory'
  | 'pi-package' | 'gemini-extension' | 'copilot-marketplace'
  | 'grok-cli' | 'grok-directory' | 'generic-skills';

export interface PhysicalIdentity {
  sourceIdentity: string;
  pluginId: string;
  platform: PlatformId;
  route: InstallRoute;
  namespaceRoot: string;
  resourceKey: string;
}

export interface AgentPluginAdapter<P> {
  readonly platform: PlatformId;
  discover(ctx: ReadContext): Promise<DiscoveryResult>;
  resolve(ctx: ReadContext, request: ResolveRequest): Promise<Resolution>;
  inspect(ctx: ReadContext, binding: DeploymentBinding): Promise<DeploymentObservation>;
  capabilities(input: CapabilityInput): PlatformCapabilitiesV1;
  project(ctx: StageContext, input: ProjectionInput): Promise<ProjectionResult>;
  lifecycle: {
    prepare(input: LifecyclePrepareInput): PrepareResult<P>;
    execute(ctx: MutationContext, prepared: PreparedDeployment<P>): Promise<DeploymentReceipt>;
  };
}

export interface ResolveRequest {
  plugin: PluginIdentity;
  scope: ScopeRef;
  operation: LifecycleOperation;
  discovery: DiscoveryResult;
  recoveryCandidates: RecoveryCandidate[];
}
export interface Resolution {
  bindings: DeploymentBinding[];
  renderUnits: RenderUnit[];
  exclusions: Array<{ productId: string | null; reasonCode: string }>;
  diagnostics: Diagnostic[];
}
/** Identified products excluded from this operation; missing products are not requirements. */
export interface DeploymentExclusion {
  platform: PlatformId;
  pluginId: string;
  scope: ScopeRef;
  productId: string;
  product: ProductInstallation | null;
  reasonCode: string;
  execution: 'not-run';
  recoveryActions: string[];
}
export type LifecycleOperation = 'ensure' | 'reinstall' | 'remove' | 'cleanup';
export interface CapabilityInput {
  binding: DeploymentBinding;
  renderUnit: RenderUnit;
  observation: DeploymentObservation;
  profile: QualifiedPlatformProfile;
}

export interface ProjectionInput {
  binding: DeploymentBinding;
  renderUnit: RenderUnit;
  capabilities: PlatformCapabilitiesV1;
  components: PluginComponent[]; // 同一 binding、同一 renderScope 的完整已校验组件集合
  policy: ResolvedInvocationPolicy;
  resources: VerifiedResourceClosure;
}
export interface ProjectionResult {
  renderUnitId: string;
  bundle: { stagingRoot: string; contentDigest: string } | null;
  supplements: HostContribution[];
  components: Array<{ id: string; nativeName: string; relativeOutputs: string[] }>;
  diagnostics: Diagnostic[];
}
export interface HostContribution {
  id: string;
  componentIds: string[];
  kind: 'owned-file' | 'owned-directory' | 'config-entry';
  destination: string;
  contentDigest: string;
  stagingPath: string;
  mergeKey?: string;
}
export interface LifecyclePrepareInput {
  operation: LifecycleOperation;
  binding: DeploymentBinding;
  observation: DeploymentObservation;
  projections: ProjectionResult[];
  expected: ExpectedComponentSet;
  evidence: PreparationEvidence;
}
export type PrepareResult<P> =
  | { status: 'ready'; prepared: PreparedDeployment<P> }
  | { status: 'blocked'; diagnostics: Diagnostic[] };
export interface PreparedDeployment<P> {
  readonly plan: FrozenDeploymentPlan;
  readonly driverState: P;
}
export interface FrozenDeploymentPlan {
  binding: DeploymentBinding;
  operation: LifecycleOperation;
  expected: ExpectedComponentSet;
  projections: ProjectionResult[];
  effects: PlannedEffect[];
  evidence: PreparationEvidence;
}
export interface PlannedEffect {
  id: string;
  kind: 'publish-package' | 'register' | 'refresh' | 'activate' |
    'deactivate' | 'unregister' | 'write-supplement' | 'remove-owned';
  physicalKey: string;
  activationKey?: string;
  componentIds: string[];
  destination: string;
  destructive: boolean;
}

export type Presence = 'present' | 'absent' | 'unknown' | 'not-applicable';
export type Activation = 'enabled' | 'disabled' | 'blocked' | 'unknown' | 'not-applicable';
export interface DeploymentObservation {
  /** Version read from the verified owned package descriptor; absence means unknown. */
  packageVersion?: string;
  /** Observed native installation bytes; absence does not confirm the installed content. */
  nativePackageContentDigest?: string;
  physicalKey: string;
  package: Presence;
  registration: Presence;
  ownership: 'aw' | 'foreign' | 'shared' | 'unknown' | 'absent';
  consumers: Array<{
    productId: string;
    activationKey: string;
    activation: Activation;
    trust: 'trusted' | 'required' | 'blocked' | 'unknown' | 'not-applicable';
    load: 'observed' | 'not-observed' | 'unknown' | 'not-applicable';
  }>;
  components: Array<{ id: string; presence: Presence; reasonCodes: string[] }>;
  nativeIdentity: NativeIdentity | null;
  prerequisites: RuntimePrerequisites;
  diagnostics: Diagnostic[];
}
export interface RuntimePrerequisites {
  agentConsumers: {
    observation: 'complete' | 'unknown';
    candidates: AgentConsumerObservation[];
    configurationEvidence?: string;
    reasonCodes: string[];
  };
  nativeSources?: {
    observation: 'complete' | 'unknown';
    configurationEvidence: string;
    sources: Array<{ name: string; version: string | null; path: string; scope: string;
      origin: 'native' | 'compatibility' | 'unknown'; enabled: boolean | null; effectiveComponents: string[] }>;
    overlaps: string[];
  };
}
export interface AgentConsumerObservation {
  productId: string;
  id: string;
  version: string | null;
  scope: ScopeRef;
  enabled: 'yes' | 'no' | 'unknown';
  trust: 'trusted' | 'required' | 'blocked' | 'unknown';
  packageAccess: 'allowed' | 'denied' | 'unknown';
  settings: {
    promptMode: 'host-default' | 'append' | 'replace' | 'unknown';
    loadExtensions: 'yes' | 'no' | 'host-default' | 'unknown';
  };
  configurationEvidence: string;
  reasonCodes: string[];
}
export interface NativeIdentity {
  route: InstallRoute;
  packageId: string;
  registrationId?: string;
  sourceLocation: string;
}
export interface DeploymentReceipt {
  bindingId: string;
  effects: Array<{
    id: string;
    status: 'applied' | 'unchanged' | 'blocked' | 'failed' | 'unknown' | 'skipped';
    mutation: 'none' | 'confirmed' | 'possible';
    diagnostics: Diagnostic[];
  }>;
  after: DeploymentObservation;
  unmet: ComponentGap[];
  reload: 'none' | 'new-session' | 'workspace-reload' | 'host-restart' | 'unknown';
  diagnostics: Diagnostic[];
}

export interface StageContext extends ReadContext {
  stagingRoot: string;
  commandResolver?: import('../generators/permissions.js').CommandReferenceResolver;
}
export interface RecoveryCandidate {
  binding: DeploymentBinding;
  physicalIdentity: PhysicalIdentity;
  nativeIdentity: NativeIdentity | null;
  evidence: 'verified' | 'unknown';
}
export interface QualifiedPlatformProfile {
  id: string;
  platform: PlatformId;
  /** Qualification is explicit per capability; a version match alone grants none. */
  kinds: PlatformCapabilitiesV1['kinds'];
  features: PlatformCapabilitiesV1['features'];
  qualifiedConsumers?: Partial<Record<ComponentKind, Array<{ product: ProductInstallation['product']; version: string }>>>;
  /** Recorded scope limits apply to both runtime and authoring kind views. */
  qualificationEvidence?: Array<{ reference: string; product: ProductInstallation['product']; version: string;
    platform: NodeJS.Platform; arch: NodeJS.Architecture; scopes: Array<ScopeRef['kind']>; kinds: ComponentKind[]; features: string[]; limitations: string[] }>;
  agentConsumers: Array<{
    id: string;
    minimumVersion: string;
    promptModes: Array<'host-default' | 'append' | 'replace'>;
    qualified: boolean;
    features: PlatformCapabilitiesV1['features'];
  }>;
}

export interface DeploymentLayoutEvidence {
  packageRoot: string;
  activationPath: string;
  supplementRoot: string | null;
  marketplaceRoot: string | null;
  marketplaceName: string | null;
}
export interface PreparationEvidence {
  fingerprint: string;
  managedCommandReview?: import('../utils/managed-command-review.js').ManagedCommandReviewEvidence;
  marketplace?: { files: Array<{ relativePath: string; contentBase64: string; contentDigest: string }>; fingerprint: string };
  layout: DeploymentLayoutEvidence;
  renderUnits?: RenderUnit[];
  ownership: Array<{
    component: import('../utils/ownership.js').OwnedComponent;
    state: 'present' | 'partial' | 'absent' | 'foreign' | 'error';
    contentDigest?: string;
    physicalKey?: string;
  }>;
  sharedReferences: 'none' | 'present' | 'unknown';
  retainPackage?: boolean;
  nativeIdentity: NativeIdentity | null;
  contentMatches: boolean;
  userActivationEnabled?: boolean | 'unknown';
}
export interface MutationOutcome {
  mutation: 'none' | 'confirmed' | 'possible';
  changed: boolean;
}
export interface MutationContext extends ReadContext {
  /** Operation-local receipts for native actions on a shared registration. */
  nativeEffects?: Map<string, Promise<MutationOutcome>>;
  /** Checked Gemini configuration baseline, rebased only after this operation's writes. */
  geminiActivationSnapshot?: { path: string; contentDigest: string | null };
  services: {
    verifyEvidence(plan: FrozenDeploymentPlan): Promise<boolean>;
    publishPackage(binding: DeploymentBinding, bundle: NonNullable<ProjectionResult['bundle']>, destination: string,
      component: import('../utils/ownership.js').OwnedComponent): Promise<MutationOutcome>;
    writeContribution(binding: DeploymentBinding, contribution: HostContribution,
      component: import('../utils/ownership.js').OwnedComponent): Promise<MutationOutcome>;
    removeOwned(binding: DeploymentBinding, component: import('../utils/ownership.js').OwnedComponent): Promise<MutationOutcome>;
    setActivation(binding: DeploymentBinding, identity: NativeIdentity, enabled: boolean): Promise<MutationOutcome>;
    registerMarketplace(binding: DeploymentBinding, identity: NativeIdentity): Promise<MutationOutcome>;
  };
  inspect?: (binding: DeploymentBinding) => Promise<DeploymentObservation>;
}
