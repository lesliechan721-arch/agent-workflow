export type Digest = `sha256:${string}`

export interface ValidationResult<TCalculated = unknown> {
  valid: boolean
  errors: string[]
  calculated: TCalculated | null
}

export interface EvalProviderCapabilities {
  schemaVersion: 2
  provider: string
  providerVersion: string
  capabilities: {
    triggerDiscovery: boolean
    conversation: boolean
    skillPathExecution: boolean
    previousVersionBaseline: boolean
    withoutSkillBaseline: boolean
    cleanContext: boolean
    parallelRuns: boolean
    toolTrace: boolean
    tokenUsage: boolean
    duration: boolean
    sandbox: boolean
    materialization: boolean
  }
  limitations: string[]
}

export type RuntimeCapabilities = EvalProviderCapabilities

export interface EvalProviderArtifactOutput {
  path: string
  role?: 'trace' | 'report' | 'output' | 'other'
}

export interface EvalProviderOutput {
  schemaVersion: 1
  provider: { id: string; version: string }
  usage: Record<string, unknown> | null
  grading: Record<string, unknown> | null
  artifacts: EvalProviderArtifactOutput[]
}

export interface RuntimeSkillSnapshot {
  root: string
  digest: Digest
}

export interface ProcessRequest {
  executable: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxBufferBytes: number
  signal?: AbortSignal
}

export interface ProviderProcessHandle {
  pid: number
}

export type ProcessTerminationReason = 'complete' | 'timeout' | 'abort' | 'max-buffer'

export interface ProcessTreeCleanupConfirmation {
  confirmed: true
}

export interface ExternalContainmentConfirmation {
  confirmed: true
  descendantCleanupGuaranteed: true
  readOnlySkillSnapshotGuaranteed: true
}

export interface ProcessLifecycleHooks {
  externalContainment?: ExternalContainmentConfirmation
  onSpawn?(handle: ProviderProcessHandle): void | Promise<void>
  terminateProcessTree?(
    handle: ProviderProcessHandle,
    reason: ProcessTerminationReason,
  ): Promise<ProcessTreeCleanupConfirmation>
}

export interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  cancelled: boolean
  terminationReason: ProcessTerminationReason | null
  maxBufferExceeded: boolean
  stdoutTruncated: boolean
  stderrTruncated: boolean
  descendantCleanupGuaranteed: boolean
  gradingEvidenceAccepted: boolean
  containmentMode: 'managed' | 'verified-observed' | 'observed' | 'unmanaged-confirmed'
  containmentLimitation?: string
}

export interface RunExecutionPlanOptions {
  auditPaths: string[]
  processHooks?: ProcessLifecycleHooks
  beforeBundleCommit?: () => void | Promise<void>
  sourceEnv?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  processTree?: import('./process-tree.js').ProcessTreeDependencies
}

export interface RunExecutionResult {
  valid: true
  bundlePath: string
  bundleDigest: Digest
  evidenceLevel: 'executed' | 'comparative'
  requirementsMet: boolean
}

export type SchemaName =
  | 'aw-skill-eval-execution-plan'
  | 'eval-run-bundle'
  | 'eval-audit-result'
  | 'eval-provider-capabilities'
  | 'eval-provider-output'
