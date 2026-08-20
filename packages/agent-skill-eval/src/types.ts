export type Digest = `sha256:${string}`

export interface ValidationResult<TCalculated = unknown> {
  valid: boolean
  errors: string[]
  calculated: TCalculated | null
}

export interface RuntimeCapabilities {
  schemaVersion: 1
  provider: string
  providerVersion: string
  capabilities: {
    triggerDiscovery: boolean
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

export interface ProcessLifecycleHooks {
  onSpawn?(handle: ProviderProcessHandle): void | Promise<void>
  terminateProcessTree?(
    handle: ProviderProcessHandle,
    reason: ProcessTerminationReason,
  ): Promise<void | ProcessTreeCleanupConfirmation>
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
}

export type ProcessRunner = (
  request: ProcessRequest,
  hooks?: ProcessLifecycleHooks,
) => Promise<ProcessResult>

export interface RunExecutionPlanOptions {
  processRunner?: ProcessRunner
  processHooks?: ProcessLifecycleHooks
  beforeBundleCommit?: () => void | Promise<void>
}

export interface RunExecutionResult {
  valid: true
  bundlePath: string
  bundleDigest: Digest
  evidenceLevel: 'executed' | 'comparative'
}

export type SchemaName =
  | 'eval-execution-plan'
  | 'eval-run-bundle'
  | 'eval-audit-result'
  | 'eval-runtime-capabilities'
