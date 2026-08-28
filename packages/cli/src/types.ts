export type * from '@lesliechan721/aw-plugin-core/manifest';
import type {
  ArtifactState,
  ArtifactTarget,
  CatalogChannel,
  CatalogManifestV5,
  CatalogSourceId,
  CliVersion,
  DistributionName,
  DynamicArtifactKind,
  ManagedArtifactId,
  PlatformName,
  PluginId,
  PluginLifecycleEvent,
  PluginVersion,
  Scope,
  SourceIdentity,
  TrackedHookGroupIdentity,
} from '@lesliechan721/aw-plugin-core/manifest';

export type ArtifactSurface =
  | { kind: 'platform'; name: PlatformName }
  | { kind: 'distribution'; name: DistributionName };
export type PlatformSelection = PlatformName | 'both';
export type CommandAction =
  | 'install'
  | 'uninstall'
  | 'upgrade'
  | 'upgradeAll'
  | 'reinstall'
  | 'cleanup'
  | 'config'
  | 'status';
export type RebuildCommand = 'install' | 'upgrade' | 'cleanup' | 'reinstall' | 'uninstall';
export type RebuildActionName =
  | 'preflight.inspect'
  | 'stale.cleanup'
  | 'native.write'
  | 'artifacts.write'
  | 'active.prepare'
  | 'active.discard'
  | `lifecycle.${PluginLifecycleEvent}`
  | 'active.promote'
  | 'postcheck.inspect'
  | 'marketplace.commit'
  | 'marketplace.rollback'
  | 'recovery.cleanup'
  | 'cleanup.owned'
  | 'active.read'
  | 'active.remove';
export type RebuildActionEventData =
  | {
      name: RebuildActionName;
      phase: 'start';
    }
  | {
      name: RebuildActionName;
      phase: 'success';
      durationMs: number;
    }
  | {
      name: RebuildActionName;
      phase: 'failure';
      durationMs: number;
      message?: string;
    };
export interface RebuildActionEvent {
  type: 'rebuild:action';
  source: {
    plugin: string;
    platform: PlatformName;
    scope: Scope;
    action: RebuildCommand;
  };
  data: RebuildActionEventData;
}
export type StrictSemVerString = string;
export type CatalogVersion = StrictSemVerString;
export type AgentVersionStatus = 'supported' | 'missing' | 'probeFailed' | 'unparseable' | 'tooOld';
export type AgentVersionReasonCode =
  | 'agentVersionMissing'
  | 'agentVersionProbeFailed'
  | 'agentVersionUnparseable'
  | 'agentVersionTooLow';
export type ConfigFieldKind = 'manifest';
export type ConfigValueState = 'default' | 'configured' | 'invalid';
export type NextStepKind = 'uiAction' | 'cliCommand' | 'manual';
export type ManualNextStepKind = 'guidance' | 'blocker' | 'documentation';
export type TargetWriteState = 'completed' | 'failed';
export type ReceiptOverallState = 'succeeded' | 'failed';

export type CatalogGitRefPolicy =
  | { type: 'explicit'; ref: string }
  | { type: 'cliChannel' };

interface CatalogSourceBase {
  id: CatalogSourceId;
  primary: boolean;
}

export interface GitCatalogSource extends CatalogSourceBase {
  type: 'git';
  url: string;
  refPolicy: CatalogGitRefPolicy;
  subdir?: string;
}

export interface PathCatalogSource extends CatalogSourceBase {
  type: 'path';
  path: string;
  managedBy?: {
    kind: 'catalog-workspace';
    workspaceIdentity: string;
  };
}

export type CatalogSource = GitCatalogSource | PathCatalogSource;

export interface CatalogSourcesConfig {
  schemaVersion: 2;
  sources: CatalogSource[];
}

export interface CatalogSourceResolution {
  sourceId: CatalogSourceId;
  sourceIdentity: SourceIdentity;
  requestedRef: string;
  resolvedCommit: string;
  rootDir: string;
  manifest: CatalogManifestV5;
  manifestDigest: string;
  snapshotDigest: string;
  cacheEntryKey: string;
  source: 'remote' | 'cache' | 'path';
  cacheFallback: boolean;
  remoteFailure?: string;
}

export interface CatalogProviderRuntimeOptions {
  cliVersion: CliVersion;
  freshnessPolicy: CatalogFreshnessPolicy;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface NextStepInstruction {
  kind: NextStepKind;
  label: string;
  description: string;
  manualKind?: ManualNextStepKind;
  uiAction?: string;
  command?: string;
}

export interface NextStepsPayloadBoundary {
  nextStepsSchemaVersion: 1;
  nextSteps: NextStepInstruction[];
  legacyNextSteps?: string[];
}

export interface ReceiptTargetIdentity {
  pluginName: string;
  pluginId?: PluginId;
  marketplaceName?: string;
  sourceId?: CatalogSourceId;
  sourceIdentity?: SourceIdentity;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
}

export interface ReceiptTargetResult {
  target: ReceiptTargetIdentity;
  action: string;
  state: TargetWriteState;
  message?: string;
  errorCode?: string;
}

export interface ConfigFieldEntry {
  key: string;
  title: string;
  kind: ConfigFieldKind;
  reserved: boolean;
  writable: boolean;
  valueState: ConfigValueState;
  effectiveValue: unknown | null;
  sourceLayer: 'default' | 'user' | 'project' | 'local' | null;
  storedValue?: unknown;
  storedSourceLayer?: 'user' | 'project' | 'local';
}

export interface ConfigReceiptFieldEntry {
  key: string;
  title: string;
  kind: ConfigFieldKind;
  reserved: boolean;
  action: 'set' | 'unset' | 'reset';
  scope: Scope;
  projectLayer?: 'shared' | 'local';
  valueState?: ConfigValueState;
}

export interface ConfigSchemaEvidence {
  source: 'currentCatalog';
  identity: string;
  pluginVersion: PluginVersion;
  manifestDigest: string;
}

export type PortablePluginRelation = 'requested' | 'direct' | 'transitive';

export interface PortableSkillCandidate {
  name: string;
  description: string;
  providerPluginId: PluginId;
  providerDisplayName: string;
  relation: PortablePluginRelation;
  dynamic: boolean;
  filesDigest: string;
}

export interface ArtifactPlanBase {
  version: 2;
  artifacts: ArtifactPlanArtifact[];
}

export type ArtifactPlan = ArtifactPlanBase;

export interface ArtifactPlanArtifactBase {
  id: ManagedArtifactId;
  platform?: PlatformName;
  distribution?: DistributionName;
  target: ArtifactTarget;
  kind: DynamicArtifactKind;
  state: ArtifactState;
  refreshKeys: string[];
  disabledReason?: string;
}

export interface DeveloperInstructionsBlockArtifact extends ArtifactPlanArtifactBase {
  target: 'codex.developerInstructionsBlock';
  kind: 'instruction';
  content?: string;
}

export interface CodexAgentRoleArtifact extends ArtifactPlanArtifactBase {
  target: 'codex.agentRole';
  kind: 'codexRole';
  roleKey?: string;
  content?: {
    registration?: {
      description?: string;
    };
    roleFile?: {
      name?: string;
      description?: string;
      developer_instructions?: string;
      model?: string;
      model_reasoning_effort?: string;
    };
  };
}

export interface CodexSkillArtifact extends ArtifactPlanArtifactBase {
  target: 'codex.skill';
  kind: 'skill';
  skillKey?: string;
  content?: {
    files?: Record<string, string>;
  };
}

export interface ClaudeSkillArtifact extends ArtifactPlanArtifactBase {
  target: 'claude.skill';
  kind: 'skill';
  skillKey?: string;
  content?: {
    files?: Record<string, string>;
  };
}

export interface AgentSkillsSkillArtifact extends ArtifactPlanArtifactBase {
  distribution: 'agent-skills';
  target: 'agent-skills.skill';
  kind: 'skill';
  skillKey: string;
  content?: {
    files?: Record<string, string>;
  };
}

export type ArtifactPlanArtifact =
  | DeveloperInstructionsBlockArtifact
  | CodexAgentRoleArtifact
  | CodexSkillArtifact
  | ClaudeSkillArtifact
  | AgentSkillsSkillArtifact;

export interface GeneratedArtifact {
  path: string;
  paths?: string[];
  kind: 'instruction' | 'permission' | 'hook' | 'agent' | 'skill' | 'mcpServer';
  platform: PlatformName;
  artifactKey?: string;
  hookGroups?: TrackedHookGroupIdentity[];
  id?: ManagedArtifactId;
  target?: ArtifactTarget;
  state?: ArtifactState;
  disabledReason?: string;
  refreshKeys?: string[];
  configDigest?: string;
  contentDigest?: string;
  roleKey?: string;
}

export interface AgentVersionRequirement {
  platform: PlatformName;
  command: string;
  displayName: string;
  minVersion: StrictSemVerString;
}

export interface AgentVersionProbeResult {
  platform: PlatformName;
  command: string;
  status: AgentVersionStatus;
  requiredMinVersion: StrictSemVerString;
  detectedVersion?: StrictSemVerString;
  reasonCode?: AgentVersionReasonCode;
  stdout: string;
  stderr: string;
  rawOutput: string;
  exitCode?: number;
  details?: string;
}

export interface AgentVersionGateFailure {
  platform: PlatformName;
  command: CommandAction | string;
  probeCommand: string;
  status: Exclude<AgentVersionStatus, 'supported'>;
  reasonCode: AgentVersionReasonCode;
  detectedVersion?: StrictSemVerString;
  requiredMinVersion: StrictSemVerString;
  failureReason: string;
  suggestedAction: string;
  rawVersionOutput?: string;
}

export interface AgentVersionGateErrorPayload {
  command: CommandAction | string;
  failures: AgentVersionGateFailure[];
}

export interface CommandOptions {
  scope: Scope;
  platform: PlatformSelection;
  cwd: string;
  scriptTimeoutMs?: number;
}

export type InstallCommandOptions = CommandOptions;

export interface UpgradeCommandOptions extends CommandOptions {
  all?: boolean;
}

export interface StatusCommandOptions {
  cwd: string;
  scope?: Scope;
  platform?: PlatformName | 'both';
  verbose?: boolean;
  json?: boolean;
}

export class CommandWarningError extends Error {
  readonly warnings: string[];
  readonly exitCode: number;

  constructor(
    message: string,
    options: {
      warnings?: string[];
      exitCode?: number;
    } = {},
  ) {
    super(message);
    this.name = 'CommandWarningError';
    this.warnings = [...new Set(options.warnings ?? [])];
    this.exitCode = options.exitCode ?? 1;
  }
}

export function isCommandWarningError(error: unknown): error is CommandWarningError {
  return (
    error instanceof Error &&
    error.name === 'CommandWarningError' &&
    Array.isArray((error as CommandWarningError).warnings) &&
    typeof (error as CommandWarningError).exitCode === 'number'
  );
}

export class AgentVersionGateError extends Error {
  readonly code = 'AGENT_VERSION_GATE_FAILED';
  readonly payload: AgentVersionGateErrorPayload;

  constructor(
    message: string,
    payload: AgentVersionGateErrorPayload,
  ) {
    super(message);
    this.name = 'AgentVersionGateError';
    this.payload = payload;
  }
}

export function isAgentVersionGateError(error: unknown): error is AgentVersionGateError {
  return (
    error instanceof Error &&
    error.name === 'AgentVersionGateError' &&
    typeof (error as AgentVersionGateError).code === 'string' &&
    typeof (error as AgentVersionGateError).payload === 'object' &&
    Array.isArray((error as AgentVersionGateError).payload.failures)
  );
}


export type CatalogFreshnessPolicy = 'cacheFirst' | 'requireRemote' | 'forceRemote';

export interface CatalogResolution {
  rootDir: string;
  source: 'local' | 'embedded' | 'remote' | 'cache';
  channel?: CatalogChannel;
  catalogVersion?: CatalogVersion;
}
