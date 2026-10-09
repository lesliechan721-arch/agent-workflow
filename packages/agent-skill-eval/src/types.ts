export type Digest = `sha256:${string}`

export interface ValidationResult<TCalculated = unknown> {
  valid: boolean
  errors: string[]
  calculated: TCalculated | null
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
  stdin?: string
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

export type SchemaName =
  | 'eval-spec'
  | 'eval-audit'
  | 'eval-result'
  | 'instruction-v2-request'
  | 'instruction-v2-receipt'
  | 'workflow-fixture-action'
  | 'workflow-evaluation'
