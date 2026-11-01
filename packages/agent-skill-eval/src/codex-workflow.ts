import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'

import fs from 'fs-extra'

import {
  CodexEvalAttemptControl,
  EvalAppServerSession,
  extractAppServerThreadId,
  assertHostReadContainmentAvailable,
  hostReadContainmentProfile,
  type CodexEvalProcessManagementEvidence,
} from './codex-eval-app-server.js'
import {
  applyCodexEvalProviderEnvironment,
  createCodexEvalTemporaryRoot,
  materializeCodexEvalRuntimeHome,
  redactCodexEvalValue,
  type CodexEvalRuntimeConfig,
} from './codex-eval-runtime-config.js'
import { applyCodexEvalGitIsolation } from './codex-eval-isolation.js'
import { readCodexEvalRollouts, selectedCodexSkillInstruction } from './codex-eval-rollout.js'
import {
  parseInstructionV2ReasoningEffort,
  parseInstructionV2Receipt,
  parseInstructionV2Transport,
  type InstructionV2ReasoningEffort,
  type InstructionV2Receipt,
  type InstructionV2Transport,
} from './instruction-v2.js'
import type { ProcessTreeDependencies } from './process-tree.js'
import { runProviderProcess } from './process.js'
import { assertProviderRunPaths } from './run-paths.js'
import {
  parseEvalProviderGrade,
  type EvalProviderGrade,
  type EvalProviderRunInput,
  type EvalProviderRunResult,
} from './custom-process.js'
import { createCodexGrader, parseConversationGraderOutput } from './providers.js'
import {
  parseWorkflowEvaluation,
  normalizeWorkflowChecks,
  WorkflowEvaluation,
  type WorkflowEvaluationRequest,
} from './codex-workflow-evaluation.js'
import { runWorkflowFixtureAction, validateWorkflowFixtureActions, type WorkflowFixtureAction } from './codex-workflow-fixtures.js'

const MAX_ADAPTER_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_REQUEST_TEXT_BYTES = 200_000
const MAX_ROLE_COUNT = 32
const MAX_ROLE_DESCRIPTION_BYTES = 20_000
const MAX_V1_EXEC_INPUT_BYTES = MAX_REQUEST_TEXT_BYTES + 16_384
const V1_CODE_MODE_SPAWN_MARKER = 'multi_agent_v1__spawn_agent'

export const CODEX_WORKFLOW_ARTIFACTS = [
  { path: 'workflow-evidence.json', role: 'evidence' },
  { path: 'workflow-trace.json', role: 'trace' },
  { path: 'model-output.txt', role: 'output' },
] as const

export interface CodexWorkflowProvider {
  type: 'codex-workflow'
  command: readonly [string, ...string[]]
  allowedModels: readonly string[]
}

export interface CodexWorkflowRole {
  name: string
  description: string
  configFile: string
}

export interface CodexWorkflowRequest {
  version: 1
  prompt: string
  sandbox: 'read-only' | 'workspace-write'
  model: string | null
  reasoningEffort?: InstructionV2ReasoningEffort
  developerInstructions: string
  roles: CodexWorkflowRole[]
  evaluation?: WorkflowEvaluationRequest
  transport?: InstructionV2Transport
  multiAgent: {
    protocol: 'v1' | 'v2'
    maxDepth: number
    hideSpawnAgentMetadata: boolean
    exposeSpawnAgentModelOverrides: boolean
  }
}

export interface CodexWorkflowArtifact {
  path: string
  role: string
}

export interface CodexWorkflowAdapterInput {
  version: 1
  phase: 'prepare' | 'grade'
  case: Record<string, unknown>
  variant: EvalProviderRunInput['variant']
  attempt: number
  paths: {
    workspace: string
    fixtures: string
    output: string
    evidence?: string
    modelOutput?: string
  }
}

export interface CodexWorkflowCall {
  ordinal: number
  threadId: string
  parentThreadId: string | null
  linkedThreadId?: string
  callId: string | null
  namespace: string | null
  tool: string
  arguments: unknown
  effectiveRuntime?: {
    model?: string
    reasoningEffort?: string
  }
  output: unknown
  status: string | null
}

export interface CodexWorkflowEvidence {
  version: 1
  rootThreadId: string
  completion: {
    status: 'completed' | 'failed' | 'cancelled' | 'unknown'
    turnStatus: string
    durationMs: number
  }
  termination: {
    reason: 'completed' | 'failed' | 'cancelled' | 'unknown'
    appServerProcessTreeCleanupConfirmed?: true
    providerProcessCleanupConfirmed?: boolean
  }
  usage: unknown
  finalMessage: string
  workspaceDiff: {
    added: string[]
    removed: string[]
    modified: string[]
  }
  skillLoads: Array<{ threadId: string; skill: string; callId: string | null }>
  threadGraph: Array<{
    threadId: string
    parentThreadId: string | null
    agentRole: string | null
    initialMessage:
      | { kind: 'plaintext'; text: string }
      | { kind: 'opaque-link'; sha256: string; linkedCallId: string }
      | null
    developerContext: {
      present: boolean
      messageCount: number
      sha256: string | null
      hasMultiAgentModeGate: boolean
      hasNestedAgentCapability: boolean
      hasCodexExploreDeveloperAuthorization: boolean
    }
  }>
  collaborationCalls: CodexWorkflowCall[]
  leafCalls: CodexWorkflowCall[]
  cleanup: {
    isolatedCodexHomeRemoved: true
  }
  evaluation?: Record<string, unknown>
  launch?: {
    instructionChannel: 'developer'
    developerInstructions: string
    instructionsRevision: string
    model: string | null
    reasoningEffort: InstructionV2ReasoningEffort | null
    sandbox: CodexWorkflowRequest['sandbox']
    roles: CodexWorkflowRole[]
    configOverrides: string[]
    hostRoleAdoption: 'unknown'
  }
  transport?: {
    type: 'instruction-v2'
    request: InstructionV2Transport['request']
    command: readonly string[]
    receipt: InstructionV2Receipt | null
    traceAvailable: boolean
    observationLimits: string[]
    diagnostic: string | null
    exitCode: number | null
    signal: NodeJS.Signals | null
    stderr: string
  }
}

export interface CodexWorkflowExecutionResult {
  evidence: CodexWorkflowEvidence
  trace: unknown[]
  modelOutput: string
  usage: unknown
}

export interface CodexWorkflowTransportInput {
  request: CodexWorkflowRequest
  input: EvalProviderRunInput
  evalRoot: string
  codexRuntime: CodexEvalRuntimeConfig
  codexBin: string
  sourceEnv: NodeJS.ProcessEnv
  timeoutMs: number
  processManagement: CodexEvalProcessManagementEvidence
  processTree?: ProcessTreeDependencies
  protectedEvalRoots?: readonly string[]
  signal?: AbortSignal
}

export interface CodexWorkflowTransport {
  run(input: CodexWorkflowTransportInput): Promise<CodexWorkflowExecutionResult>
}

export interface CodexWorkflowExecutorOptions {
  provider: CodexWorkflowProvider
  evalRoot: string
  input: EvalProviderRunInput
  codexRuntime: CodexEvalRuntimeConfig
  sourceEnv?: NodeJS.ProcessEnv
  codexBin?: string
  platform?: NodeJS.Platform
  processTree?: ProcessTreeDependencies
  processManagement?: CodexEvalProcessManagementEvidence
  transport?: CodexWorkflowTransport
  protectedEvalRoots?: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing ${key}.`)
  }
  const allowed = new Set([...required, ...optional])
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) throw new Error(`${label} has unknown field ${unknown}.`)
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`)
  }
  if (Buffer.byteLength(value) > maxBytes) throw new Error(`${label} is too large.`)
  return value
}

function relativeWorkspacePath(value: unknown, label: string): string {
  const result = boundedString(value, label, 4_096)
  if (
    result.includes('\\')
    || result.includes('\0')
    || path.posix.isAbsolute(result)
    || path.win32.isAbsolute(result)
    || path.posix.normalize(result) !== result
    || result.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) throw new Error(`${label} must be a normalized workspace-relative POSIX path.`)
  return result
}

async function assertWorkspaceRoleFile(workspace: string, relative: string): Promise<void> {
  let current = workspace
  for (const segment of relative.split('/')) {
    current = path.join(current, segment)
    const info = await fs.lstat(current).catch(() => null)
    if (!info) throw new Error(`workflow role configFile does not exist: ${relative}`)
    if (info.isSymbolicLink()) {
      throw new Error(`workflow role configFile must not contain symbolic links: ${relative}`)
    }
  }
  if (!(await fs.lstat(current)).isFile()) {
    throw new Error(`workflow role configFile must be a regular file: ${relative}`)
  }
}

export async function parseCodexWorkflowRequest(
  value: unknown,
  allowedModels: readonly string[],
  workspace: string,
  fixtures?: string,
): Promise<CodexWorkflowRequest> {
  if (!isRecord(value)) throw new Error('workflow prepare stdout must be one JSON object.')
  exactKeys(
    value,
    ['version', 'prompt', 'sandbox', 'model', 'developerInstructions', 'roles', 'multiAgent'],
    ['evaluation', 'transport', 'reasoningEffort'],
    'workflow prepare stdout',
  )
  if (value.version !== 1) throw new Error('workflow prepare stdout version must be 1.')
  if (value.sandbox !== 'read-only' && value.sandbox !== 'workspace-write') {
    throw new Error('workflow request sandbox must be read-only or workspace-write.')
  }
  if (value.model !== null && (typeof value.model !== 'string' || !allowedModels.includes(value.model))) {
    throw new Error('workflow request model must be null or a member of provider.allowedModels.')
  }
  if (!Array.isArray(value.roles) || value.roles.length > MAX_ROLE_COUNT) {
    throw new Error(`workflow request roles must be an array with at most ${MAX_ROLE_COUNT} entries.`)
  }
  const roles = await Promise.all(value.roles.map(async (entry, index): Promise<CodexWorkflowRole> => {
    if (!isRecord(entry)) throw new Error(`workflow request roles[${index}] must be an object.`)
    exactKeys(entry, ['name', 'description', 'configFile'], [], `workflow request roles[${index}]`)
    const name = boundedString(entry.name, `workflow request roles[${index}].name`, 256)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
      throw new Error(`workflow request roles[${index}].name must be a safe role name.`)
    }
    const configFile = relativeWorkspacePath(
      entry.configFile,
      `workflow request roles[${index}].configFile`,
    )
    await assertWorkspaceRoleFile(workspace, configFile)
    return {
      name,
      description: boundedString(
        entry.description,
        `workflow request roles[${index}].description`,
        MAX_ROLE_DESCRIPTION_BYTES,
      ),
      configFile,
    }
  }))
  if (new Set(roles.map((role) => role.name)).size !== roles.length) {
    throw new Error('workflow request roles must contain unique names.')
  }
  if (!isRecord(value.multiAgent)) throw new Error('workflow request multiAgent must be an object.')
  exactKeys(
    value.multiAgent,
    ['protocol', 'maxDepth', 'hideSpawnAgentMetadata', 'exposeSpawnAgentModelOverrides'],
    [],
    'workflow request multiAgent',
  )
  const multiAgent = value.multiAgent
  if (multiAgent.protocol !== 'v1' && multiAgent.protocol !== 'v2') {
    throw new Error('workflow request multiAgent.protocol must be v1 or v2.')
  }
  if (!Number.isSafeInteger(multiAgent.maxDepth) || (multiAgent.maxDepth as number) < 1
    || (multiAgent.maxDepth as number) > 4) {
    throw new Error('workflow request multiAgent.maxDepth must be an integer from 1 to 4.')
  }
  if (
    typeof multiAgent.hideSpawnAgentMetadata !== 'boolean'
    || typeof multiAgent.exposeSpawnAgentModelOverrides !== 'boolean'
  ) throw new Error('workflow request multiAgent metadata fields must be boolean.')
  if (
    multiAgent.protocol === 'v1'
    && (multiAgent.hideSpawnAgentMetadata || multiAgent.exposeSpawnAgentModelOverrides)
  ) throw new Error('workflow request V1 metadata fields must be false.')
  const request: CodexWorkflowRequest = {
    version: 1,
    prompt: boundedString(value.prompt, 'workflow request prompt', MAX_REQUEST_TEXT_BYTES),
    sandbox: value.sandbox,
    model: value.model as string | null,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: parseInstructionV2ReasoningEffort(value.reasoningEffort) }),
    developerInstructions: boundedString(
      value.developerInstructions,
      'workflow request developerInstructions',
      MAX_REQUEST_TEXT_BYTES,
    ),
    roles,
    ...(value.evaluation === undefined ? {} : { evaluation: parseWorkflowEvaluation(value.evaluation) }),
    ...(value.transport === undefined ? {} : { transport: await parseInstructionV2Transport(value.transport, workspace) }),
    multiAgent: {
      protocol: multiAgent.protocol,
      maxDepth: multiAgent.maxDepth as number,
      hideSpawnAgentMetadata: multiAgent.hideSpawnAgentMetadata,
      exposeSpawnAgentModelOverrides: multiAgent.exposeSpawnAgentModelOverrides,
    },
  }
  if (request.transport) {
    const external = request.transport.request
    if (external.instructions.text !== request.developerInstructions || external.task !== request.prompt
      || external.run.access !== request.sandbox || (external.run.model ?? null) !== request.model
      || external.run.reasoningEffort !== request.reasoningEffort) {
      throw new Error('instruction-v2 request must match workflow instructions, task, access, model, and reasoningEffort.')
    }
    if (request.evaluation?.interactions.length || request.evaluation?.setupPrompt !== undefined) {
      throw new Error('instruction-v2 transport does not support evaluation interactions or setupPrompt.')
    }
  }
  const actions = [
    ...(request.evaluation?.setupActions ?? []),
    ...(request.evaluation?.finalActions ?? []),
    ...(request.evaluation?.interactions.flatMap((interaction) => interaction.action ? [interaction.action] : []) ?? []),
  ]
  if (actions.length) {
    if (!fixtures) throw new Error('workflow fixture actions require the Eval-owned fixture root.')
    await validateWorkflowFixtureActions(actions, fixtures)
  }
  return request
}

function parseJsonObject(stdout: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`${label} must be one JSON object: ${(error as Error).message}`)
  }
  if (!isRecord(value)) throw new Error(`${label} must be one JSON object.`)
  return value
}

export function codexWorkflowAdapterEnvironment(
  sourceEnv: NodeJS.ProcessEnv,
  evalRoot: string,
  phase: 'prepare' | 'grade',
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['PATH', 'LANG', 'LC_ALL'] as const) {
    if (sourceEnv[name] !== undefined) env[name] = sourceEnv[name]
  }
  const home = path.join(evalRoot, `.workflow-adapter-${phase}-home`)
  const temporary = path.join(evalRoot, `.workflow-adapter-${phase}-tmp`)
  return applyCodexEvalGitIsolation({
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.state'),
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    NO_COLOR: '1',
  })
}

async function runAdapter(options: {
  command: readonly [string, ...string[]]
  evalRoot: string
  input: CodexWorkflowAdapterInput
  sourceEnv: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
  processTree?: ProcessTreeDependencies
  processManagement: CodexEvalProcessManagementEvidence
}): Promise<Record<string, unknown>> {
  const env = codexWorkflowAdapterEnvironment(options.sourceEnv, options.evalRoot, options.input.phase)
  await Promise.all([fs.mkdir(env.HOME!, { mode: 0o700 }), fs.mkdir(env.TMPDIR!, { mode: 0o700 })])
  try {
    const result = await runProviderProcess({
      executable: options.command[0],
      args: [...options.command.slice(1)],
      cwd: options.evalRoot,
      env,
      stdin: JSON.stringify(options.input),
      timeoutMs: options.timeoutMs,
      maxBufferBytes: MAX_ADAPTER_OUTPUT_BYTES,
      ...(options.signal ? { signal: options.signal } : {}),
    }, {}, {
      containment: options.processManagement.mode === 'unmanaged-confirmed'
        ? 'unmanaged-confirmed'
        : 'verified-observed',
      ...(options.processManagement.mode === 'unmanaged-confirmed'
        ? {}
        : { processTree: options.processTree }),
    })
    if (result.timedOut) throw new Error(`workflow ${options.input.phase} timed out.`)
    if (result.cancelled) throw new Error(`workflow ${options.input.phase} was aborted.`)
    if (result.maxBufferExceeded) throw new Error(`workflow ${options.input.phase} output is too large.`)
    if (
      options.processManagement.mode !== 'unmanaged-confirmed'
      && !result.gradingEvidenceAccepted
    ) {
      throw new Error(`workflow ${options.input.phase} process containment was not verified.`)
    }
    if (result.signal || result.exitCode !== 0) {
      const diagnostic = result.stderr.trim()
      throw new Error(
        `workflow ${options.input.phase} failed (exit=${String(result.exitCode)}, `
        + `signal=${String(result.signal)})${diagnostic ? `: ${diagnostic}` : '.'}`,
      )
    }
    return parseJsonObject(result.stdout, `workflow ${options.input.phase} stdout`)
  } finally {
    const cleanup = await Promise.allSettled([fs.remove(env.HOME!), fs.remove(env.TMPDIR!)])
    if (cleanup.some((result) => result.status === 'rejected')) {
      throw new Error(`workflow ${options.input.phase} could not remove isolated adapter state.`)
    }
  }
}

interface WorkspaceSnapshotEntry {
  kind: 'directory' | 'file' | 'symlink' | 'other'
  digest: string
}

async function snapshotWorkspace(root: string): Promise<Map<string, WorkspaceSnapshotEntry>> {
  const snapshot = new Map<string, WorkspaceSnapshotEntry>()
  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      if (entry.isDirectory()) {
        snapshot.set(`${relative}/`, { kind: 'directory', digest: 'directory' })
        await visit(absolute)
      } else if (entry.isFile()) {
        snapshot.set(relative, {
          kind: 'file',
          digest: createHash('sha256').update(await fs.readFile(absolute)).digest('hex'),
        })
      } else if (entry.isSymbolicLink()) {
        snapshot.set(relative, { kind: 'symlink', digest: await fs.readlink(absolute) })
      } else snapshot.set(relative, { kind: 'other', digest: 'other' })
    }
  }
  await visit(root)
  return snapshot
}

function workspaceDiff(
  before: ReadonlyMap<string, WorkspaceSnapshotEntry>,
  after: ReadonlyMap<string, WorkspaceSnapshotEntry>,
): CodexWorkflowEvidence['workspaceDiff'] {
  const added: string[] = []
  const removed: string[] = []
  const modified: string[] = []
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort()
  for (const entry of paths) {
    if (!before.has(entry)) added.push(entry)
    else if (!after.has(entry)) removed.push(entry)
    else if (JSON.stringify(before.get(entry)) !== JSON.stringify(after.get(entry))) modified.push(entry)
  }
  return { added, removed, modified }
}

function buildEngineEnvironment(
  sourceEnv: NodeJS.ProcessEnv,
  root: string,
  codexHome: string,
  runtime: CodexEvalRuntimeConfig,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of [
    'PATH', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  ] as const) {
    if (sourceEnv[name] !== undefined) env[name] = sourceEnv[name]
  }
  const home = path.join(root, 'home')
  const temporary = path.join(root, 'tmp')
  return applyCodexEvalProviderEnvironment(applyCodexEvalGitIsolation({
    ...env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_STATE_HOME: path.join(root, 'xdg-state'),
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    NO_COLOR: '1',
  }), runtime)
}

function configValue(value: unknown): string {
  return JSON.stringify(value)
}

function workflowConfig(request: CodexWorkflowRequest, workspace: string): string[] {
  const v2 = request.multiAgent.protocol === 'v2'
  return [
    'features.multi_agent=true',
    'features.executed_tool_call_metadata=true',
    `features.multi_agent_v2.enabled=${String(v2)}`,
    `features.multi_agent_v2.hide_spawn_agent_metadata=${String(
      request.multiAgent.hideSpawnAgentMetadata,
    )}`,
    `features.multi_agent_v2.expose_spawn_agent_model_overrides=${String(
      request.multiAgent.exposeSpawnAgentModelOverrides,
    )}`,
    `agents.max_depth=${request.multiAgent.maxDepth}`,
    `developer_instructions=${configValue(request.developerInstructions)}`,
    ...(request.reasoningEffort ? [`model_reasoning_effort=${configValue(request.reasoningEffort)}`] : []),
    ...request.roles.flatMap((role) => [
      `agents.${role.name}.description=${configValue(role.description)}`,
      `agents.${role.name}.config_file=${configValue(path.join(workspace, role.configFile))}`,
    ]),
  ]
}

export function codexWorkflowFrameThreadId(frame: Record<string, unknown>): string | null {
  const params = isRecord(frame.params) ? frame.params : {}
  if (typeof params.threadId === 'string') return params.threadId
  for (const key of ['thread', 'turn', 'item'] as const) {
    const nested = isRecord(params[key]) ? params[key] : {}
    if (typeof nested.threadId === 'string') return nested.threadId
    if (key === 'thread' && typeof nested.id === 'string') return nested.id
  }
  return null
}

export function codexWorkflowFrameIsForRoot(
  frame: Record<string, unknown>,
  rootThreadId: string,
): boolean {
  return codexWorkflowFrameThreadId(frame) === rootThreadId
}

export function codexWorkflowMissingFinalMessageDiagnostic(options: {
  frames: readonly unknown[]
  rootThreadId: string
  turnStatus: string | null
  usage: unknown
}): {
  rootTurnStatus: string | null
  rootFinalAgentMessageCount: number
  otherThreadFinalAgentMessageCount: number
  usagePresent: boolean
  frameCount: number
} {
  let rootFinalAgentMessageCount = 0
  let otherThreadFinalAgentMessageCount = 0
  for (const value of options.frames) {
    if (!isRecord(value) || value.method !== 'item/completed') continue
    const params = isRecord(value.params) ? value.params : {}
    const item = isRecord(params.item) ? params.item : null
    if (!item || item.type !== 'agentMessage' || item.phase !== 'final_answer') continue
    const threadId = codexWorkflowFrameThreadId(value)
    if (threadId === options.rootThreadId) rootFinalAgentMessageCount += 1
    else if (threadId !== null) otherThreadFinalAgentMessageCount += 1
  }
  return {
    rootTurnStatus: options.turnStatus,
    rootFinalAgentMessageCount,
    otherThreadFinalAgentMessageCount,
    usagePresent: options.usage !== null && options.usage !== undefined,
    frameCount: options.frames.length,
  }
}

function hash(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function parseSerialized(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

type V1SpawnArguments = {
  agent_type?: string
  message: string
  fork_context: boolean
  model?: string
  reasoning_effort?: string
}

function skipWhitespace(source: string, start: number): number {
  let index = start
  while (/\s/u.test(source[index] ?? '')) index += 1
  return index
}

function parseJsonStringToken(source: string, start: number): { value: string; end: number } {
  if (source[start] !== '"') throw new Error('Codex V1 code-mode spawn object has an invalid string.')
  let escaped = false
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character !== '"') continue
    let value: unknown
    try {
      value = JSON.parse(source.slice(start, index + 1))
    } catch {
      throw new Error('Codex V1 code-mode spawn object has an invalid string.')
    }
    if (typeof value !== 'string') {
      throw new Error('Codex V1 code-mode spawn object has an invalid string.')
    }
    return { value, end: index + 1 }
  }
  throw new Error('Codex V1 code-mode spawn object has an unterminated string.')
}

function parseTemplateLiteralToken(source: string, start: number): { value: string; end: number } {
  if (source[start] !== '`') {
    throw new Error('Codex V1 code-mode spawn object has an invalid template literal.')
  }
  let value = ''
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!
    if (character === '`') return { value, end: index + 1 }
    if (character === '$' && source[index + 1] === '{') {
      throw new Error('Codex V1 code-mode spawn template literal interpolation is unsupported.')
    }
    if (character === '\r') {
      if (source[index + 1] === '\n') index += 1
      value += '\n'
      continue
    }
    if (character !== '\\') {
      value += character
      continue
    }

    const escaped = source[index + 1]
    if (escaped === undefined) {
      throw new Error('Codex V1 code-mode spawn object has an unterminated template literal.')
    }
    index += 1
    if (escaped === '\n') continue
    if (escaped === '\r') {
      if (source[index + 1] === '\n') index += 1
      continue
    }
    if (escaped === '\u2028' || escaped === '\u2029') continue
    const commonEscapes: Record<string, string> = {
      b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
      '0': '\0', '\\': '\\', '`': '`',
    }
    if (Object.hasOwn(commonEscapes, escaped)) {
      if (escaped === '0' && /[0-9]/u.test(source[index + 1] ?? '')) {
        throw new Error('Codex V1 code-mode spawn template literal has an invalid numeric escape.')
      }
      value += commonEscapes[escaped]
      continue
    }
    if (escaped === 'x') {
      const digits = source.slice(index + 1, index + 3)
      if (!/^[0-9A-Fa-f]{2}$/u.test(digits)) {
        throw new Error('Codex V1 code-mode spawn template literal has an invalid hex escape.')
      }
      value += String.fromCharCode(Number.parseInt(digits, 16))
      index += 2
      continue
    }
    if (escaped === 'u') {
      if (source[index + 1] === '{') {
        const close = source.indexOf('}', index + 2)
        const digits = close === -1 ? '' : source.slice(index + 2, close)
        const codePoint = /^[0-9A-Fa-f]{1,6}$/u.test(digits)
          ? Number.parseInt(digits, 16)
          : Number.NaN
        if (!Number.isInteger(codePoint) || codePoint > 0x10FFFF) {
          throw new Error('Codex V1 code-mode spawn template literal has an invalid Unicode escape.')
        }
        value += String.fromCodePoint(codePoint)
        index = close
        continue
      }
      const digits = source.slice(index + 1, index + 5)
      if (!/^[0-9A-Fa-f]{4}$/u.test(digits)) {
        throw new Error('Codex V1 code-mode spawn template literal has an invalid Unicode escape.')
      }
      value += String.fromCharCode(Number.parseInt(digits, 16))
      index += 4
      continue
    }
    if (/[1-9]/u.test(escaped)) {
      throw new Error('Codex V1 code-mode spawn template literal has an invalid numeric escape.')
    }
    value += escaped
  }
  throw new Error('Codex V1 code-mode spawn object has an unterminated template literal.')
}

function parseV1SpawnObject(
  source: string,
  start: number,
): { value: Record<string, unknown>; end: number } {
  let index = skipWhitespace(source, start)
  if (source[index] !== '{') throw new Error('Codex V1 code-mode spawn arguments must be an object.')
  index += 1
  const value: Record<string, unknown> = {}
  while (true) {
    index = skipWhitespace(source, index)
    if (source[index] === '}') return { value, end: index + 1 }
    let key: string
    if (source[index] === '"') {
      const parsed = parseJsonStringToken(source, index)
      key = parsed.value
      index = parsed.end
    } else {
      const match = source.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/u)
      if (!match) throw new Error('Codex V1 code-mode spawn object has an invalid key.')
      key = match[0]
      index += key.length
    }
    if (Object.hasOwn(value, key)) {
      throw new Error('Codex V1 code-mode spawn object has a duplicate key.')
    }
    index = skipWhitespace(source, index)
    if (source[index] !== ':') throw new Error('Codex V1 code-mode spawn object is missing a colon.')
    index = skipWhitespace(source, index + 1)
    if (source[index] === '"') {
      const parsed = parseJsonStringToken(source, index)
      value[key] = parsed.value
      index = parsed.end
    } else if (source[index] === '`') {
      const parsed = parseTemplateLiteralToken(source, index)
      value[key] = parsed.value
      index = parsed.end
    } else if (source.startsWith('true', index)) {
      value[key] = true
      index += 4
    } else if (source.startsWith('false', index)) {
      value[key] = false
      index += 5
    } else {
      throw new Error('Codex V1 code-mode spawn object has an unsupported value.')
    }
    index = skipWhitespace(source, index)
    if (source[index] === '}') return { value, end: index + 1 }
    if (source[index] !== ',') throw new Error('Codex V1 code-mode spawn object is missing a comma.')
    index = skipWhitespace(source, index + 1)
    if (source[index] === '}') return { value, end: index + 1 }
  }
}

function canonicalV1SpawnArguments(value: unknown): V1SpawnArguments {
  if (!isRecord(value)) throw new Error('Codex V1 spawn arguments must be an object.')
  const allowed = new Set(['agent_type', 'message', 'fork_context', 'model', 'reasoning_effort'])
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) throw new Error(`Codex V1 spawn arguments have unknown field ${unknown}.`)
  const agentType = Object.hasOwn(value, 'agent_type')
    ? boundedString(value.agent_type, 'Codex V1 spawn agent_type', 256)
    : undefined
  const message = boundedString(value.message, 'Codex V1 spawn message', MAX_REQUEST_TEXT_BYTES)
  if (typeof value.fork_context !== 'boolean') {
    throw new Error('Codex V1 spawn fork_context evidence must be boolean.')
  }
  const model = value.model === undefined
    ? undefined
    : boundedString(value.model, 'Codex V1 spawn model', 256)
  const reasoningEffort = value.reasoning_effort === undefined
    ? undefined
    : boundedString(value.reasoning_effort, 'Codex V1 spawn reasoning_effort', 256)
  return {
    ...(agentType === undefined ? {} : { agent_type: agentType }),
    message,
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    fork_context: value.fork_context,
  }
}

type V1WrapperFingerprint =
  | {
      phase: 'prefix'
      pragma: 'yes' | 'no'
      codeFence: 'yes' | 'no'
      declaration: 'const' | 'let' | 'var' | 'none'
      bindingForm: 'identifier' | 'object-destructure' | 'array-destructure' | 'other'
      await: 'yes' | 'no'
      receiver: 'tools' | 'other'
      calleeFamily: 'exact-v1-snake' | 'v1-namespaced-other' | 'spawn-family-other' | 'other'
      exactSpawnCallee: 'yes' | 'no'
      outputForm: 'direct-text-await' | 'other'
    }
  | {
      phase: 'suffix'
      spawnCallSemicolon: 'yes' | 'no'
      outputForm: 'text' | 'return-text' | 'other'
      extraStatements: 'yes' | 'no'
    }

function v1PrefixWrapperFingerprint(source: string): V1WrapperFingerprint {
  const pragma = /^\s*\/\/\s*@exec\b/u.test(source)
  const withoutPragma = source.replace(
    /^\s*\/\/\s*@exec\b[^\r\n]*(?:\r?\n|$)/u,
    '',
  )
  const codeFence = /^\s*```[^\r\n]*(?:\r?\n|$)/u.test(withoutPragma)
  const structuralSource = withoutPragma.replace(/^\s*```[^\r\n]*(?:\r?\n|$)/u, '')
  const declaration = structuralSource.match(/^\s*(const|let|var)\b/u)?.[1]
  const declarationPrefix = /^\s*(?:const|let|var)\s+/u
  const bindingSource = structuralSource.replace(declarationPrefix, '')
  const bindingForm = /^[A-Za-z_$][A-Za-z0-9_$]*\s*=/u.test(bindingSource)
    ? 'identifier'
    : /^\{[^}\r\n]*\}\s*=/u.test(bindingSource)
      ? 'object-destructure'
      : /^\[[^\]\r\n]*\]\s*=/u.test(bindingSource)
        ? 'array-destructure'
        : 'other'
  const assignmentAwait = /^\s*(?:const|let|var)\s+[^\r\n]*?=\s*await\b/u
  const directTextAwait = /^\s*text\s*\(\s*await\s+tools\.multi_agent_v1__spawn_agent\s*\(/u
  const callee = structuralSource.match(
    /^\s*(?:(?:const|let|var)\s+[^\r\n]*?=\s*|text\s*\(\s*)(?:await\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/u,
  )
  const receiver = callee?.[1] === 'tools' ? 'tools' : 'other'
  const calleeName = callee?.[2]
  const calleeFamily = calleeName === 'multi_agent_v1__spawn_agent'
    ? 'exact-v1-snake'
    : calleeName?.startsWith('multi_agent_v1__') === true
      ? 'v1-namespaced-other'
      : calleeName !== undefined && /(?:spawn_agent|spawnAgent)$/u.test(calleeName)
        ? 'spawn-family-other'
        : 'other'
  return {
    phase: 'prefix',
    pragma: pragma ? 'yes' : 'no',
    codeFence: codeFence ? 'yes' : 'no',
    declaration: declaration === 'const' || declaration === 'let' || declaration === 'var'
      ? declaration
      : 'none',
    bindingForm,
    await: assignmentAwait.test(structuralSource) || directTextAwait.test(structuralSource)
      ? 'yes'
      : 'no',
    receiver,
    calleeFamily,
    exactSpawnCallee: receiver === 'tools' && calleeFamily === 'exact-v1-snake' ? 'yes' : 'no',
    outputForm: directTextAwait.test(structuralSource) ? 'direct-text-await' : 'other',
  }
}

function v1SuffixWrapperFingerprint(source: string, variable: string): V1WrapperFingerprint {
  const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const textOutput = new RegExp(
    `^\\s*\\)\\s*;?\\s*text\\s*\\(\\s*${escapedVariable}\\s*\\)\\s*;?`,
    'u',
  )
  const returnTextOutput = new RegExp(
    `^\\s*\\)\\s*;?\\s*return\\s+text\\s*\\(\\s*${escapedVariable}\\s*\\)\\s*;?`,
    'u',
  )
  const output = source.match(textOutput) ?? source.match(returnTextOutput)
  return {
    phase: 'suffix',
    spawnCallSemicolon: /^\s*\)\s*;/u.test(source) ? 'yes' : 'no',
    outputForm: textOutput.test(source)
      ? 'text'
      : returnTextOutput.test(source) ? 'return-text' : 'other',
    extraStatements: output !== null && source.slice(output[0].length).trim() !== '' ? 'yes' : 'no',
  }
}

function invalidV1Wrapper(fingerprint: V1WrapperFingerprint): Error {
  return new Error(
    `Codex V1 code-mode spawn ${fingerprint.phase} is invalid. `
    + `fingerprint=${JSON.stringify(fingerprint)}`,
  )
}

function parseV1CodeModeSpawnInput(value: unknown): V1SpawnArguments {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_V1_EXEC_INPUT_BYTES) {
    throw new Error('Codex V1 code-mode spawn input must be a bounded string.')
  }
  const prefix = value.match(
    /^\s*const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:await\s+)?tools\.multi_agent_v1__spawn_agent\s*\(\s*/u,
  )
  if (!prefix) throw invalidV1Wrapper(v1PrefixWrapperFingerprint(value))
  const parsed = parseV1SpawnObject(value, prefix[0].length)
  const variable = prefix[1]!
  const suffix = value.slice(parsed.end)
  const suffixPattern = new RegExp(
    `^\\s*\\)\\s*;\\s*text\\s*\\(\\s*${variable}\\s*\\)\\s*;?\\s*$`,
    'u',
  )
  if (!suffixPattern.test(suffix)) {
    throw invalidV1Wrapper(v1SuffixWrapperFingerprint(suffix, variable))
  }
  return canonicalV1SpawnArguments(parsed.value)
}

function isV1CodeModeExecCall(call: {
  tool: string
  arguments: unknown
} | null): boolean {
  return call?.tool === 'exec'
    && isRecord(call.arguments)
    && typeof call.arguments.input === 'string'
    && call.arguments.input.includes(V1_CODE_MODE_SPAWN_MARKER)
}

function responseItem(event: Record<string, unknown>): Record<string, unknown> | null {
  return event.type === 'response_item' && isRecord(event.payload) ? event.payload : null
}

function contentText(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.content)) return ''
  return payload.content.filter(isRecord)
    .filter((entry) => entry.type === 'input_text' && typeof entry.text === 'string')
    .map((entry) => entry.text as string)
    .join('\n')
}

function selectedSkillName(event: unknown): string | null {
  const selected = selectedCodexSkillInstruction(event)
  return selected?.path.endsWith(`/.agents/skills/${selected.name}/SKILL.md`)
    ? selected.name : null
}

function encryptedContent(payload: Record<string, unknown>): string | null {
  if (!Array.isArray(payload.content)) return null
  const content = payload.content.filter(isRecord)
  const envelope = content.find((item) => item.type === 'input_text' && typeof item.text === 'string')
  if (!String(envelope?.text ?? '').includes('Message Type: NEW_TASK')) return null
  const entry = content.find((item) =>
    item.type === 'encrypted_content' && typeof item.encrypted_content === 'string')
  return entry ? entry.encrypted_content as string : null
}

function agentMessagePayload(text: string): string | null {
  const marker = text.match(/^Payload:\s*$/mu)
  if (!marker || !Number.isInteger(marker.index)) return null
  return text
    .slice(marker.index! + marker[0].length)
    .replace(/^\r?\n/u, '')
    .trim() || null
}

function sanitizeTraceValue(
  value: unknown,
  runtime: CodexEvalRuntimeConfig,
  isolatedPaths: readonly { path: string; marker: string }[],
  redactSpawnMessages: boolean,
): unknown {
  if (typeof value === 'string') {
    const redactedPath = isolatedPaths
      .filter((entry) => entry.path !== '')
      .sort((left, right) => right.path.length - left.path.length)
      .reduce((text, entry) => text.replaceAll(entry.path, entry.marker), value)
    return redactCodexEvalValue(redactedPath, runtime)
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeTraceValue(entry, runtime, isolatedPaths, redactSpawnMessages))
  }
  if (!isRecord(value)) return value
  if (
    value.type === 'custom_tool_call'
    && value.name === 'exec'
    && typeof value.input === 'string'
    && value.input.includes(V1_CODE_MODE_SPAWN_MARKER)
  ) {
    let input: unknown = '[redacted-v1-code-wrapper]'
    try {
      input = {
        namespace: 'multi_agent_v1',
        tool: 'spawn_agent',
        arguments: parseV1CodeModeSpawnInput(value.input),
      }
    } catch {
      // A linked terminal event is validated separately. An unlinked malformed wrapper stays private.
    }
    return sanitizeTraceValue(
      { ...value, input },
      runtime,
      isolatedPaths,
      redactSpawnMessages,
    )
  }
  if (value.type === 'message' && value.role === 'developer') {
    const developerText = contentText(value)
    return {
      type: 'message',
      role: 'developer',
      developerContext: {
        present: true,
        sha256: hash(developerText),
        bytes: Buffer.byteLength(developerText),
      },
    }
  }
  if (
    typeof value.name === 'string'
    && normalizeToolName(value.name).tool === 'spawn_agent'
    && redactSpawnMessages
  ) {
    const argumentsValue = parseSerialized(value.arguments ?? value.input)
    if (isRecord(argumentsValue) && typeof argumentsValue.message === 'string') {
      const argumentKey = value.arguments === undefined ? 'input' : 'arguments'
      return sanitizeTraceValue({
        ...value,
        [argumentKey]: {
          ...argumentsValue,
          message: { kind: 'opaque', sha256: hash(argumentsValue.message) },
        },
      }, runtime, isolatedPaths, redactSpawnMessages)
    }
  }
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'agentPath' || key === 'agent_path' || key === 'sender_agent_path') continue
    if (key === 'encrypted_content' && typeof entry === 'string') {
      result[key] = { redacted: true, sha256: hash(entry) }
      continue
    }
    if (/^(?:authorization|credentials?|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|ciphertext)$/iu.test(key)) {
      result[key] = '[redacted]'
      continue
    }
    result[key] = sanitizeTraceValue(entry, runtime, isolatedPaths, redactSpawnMessages)
  }
  return result
}

interface RolloutRecord {
  threadId: string
  parentThreadId: string | null
  agentPath: string | null
  agentRole: string | null
  initialUserMessage: string | null
  initialOpaqueMessage: string | null
  developerText: string
  developerMessageCount: number
  calls: Array<Omit<CodexWorkflowCall, 'ordinal'> & { order: string }>
  trace: unknown[]
}

function rolloutIdentity(events: readonly Record<string, unknown>[]): Omit<
  RolloutRecord,
  | 'calls'
  | 'trace'
  | 'initialUserMessage'
  | 'initialOpaqueMessage'
  | 'developerText'
  | 'developerMessageCount'
> {
  for (const event of events) {
    if (event.type !== 'session_meta' || !isRecord(event.payload)) continue
    const payload = event.payload
    if (typeof payload.id !== 'string' || payload.id === '') {
      throw new Error('Codex rollout session_meta is missing its thread id.')
    }
    const source = isRecord(payload.source) ? payload.source : {}
    const subagent = isRecord(source.subagent) ? source.subagent : {}
    const spawn = isRecord(subagent.thread_spawn) ? subagent.thread_spawn : {}
    return {
      threadId: payload.id,
      parentThreadId: typeof spawn.parent_thread_id === 'string' ? spawn.parent_thread_id : null,
      agentPath: typeof spawn.agent_path === 'string' ? spawn.agent_path : null,
      agentRole: typeof spawn.agent_role === 'string' ? spawn.agent_role : null,
    }
  }
  throw new Error('Codex rollout is missing session_meta.')
}

function eventTimestamp(event: Record<string, unknown>, file: string, line: number): string {
  return `${typeof event.timestamp === 'string' ? event.timestamp : ''}\0${file}\0${String(line).padStart(8, '0')}`
}

function callFromPayload(options: {
  payload: Record<string, unknown>
  identity: ReturnType<typeof rolloutIdentity>
  file: string
  line: number
  event: Record<string, unknown>
}): Omit<CodexWorkflowCall, 'ordinal'> & { order: string } | null {
  const { payload, identity } = options
  if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call') return null
  if (typeof payload.name !== 'string') return null
  const argumentsValue = payload.type === 'custom_tool_call'
    && payload.name === 'exec'
    && typeof payload.input === 'string'
    ? { input: payload.input }
    : parseSerialized(payload.arguments ?? payload.input ?? null)
  return {
    threadId: identity.threadId,
    parentThreadId: identity.parentThreadId,
    callId: typeof payload.call_id === 'string' ? payload.call_id : null,
    namespace: typeof payload.namespace === 'string' ? payload.namespace : null,
    tool: payload.name,
    arguments: argumentsValue,
    output: null,
    status: null,
    order: eventTimestamp(options.event, options.file, options.line),
  }
}

function agentMessageCall(options: {
  payload: Record<string, unknown>
  identity: ReturnType<typeof rolloutIdentity>
  file: string
  line: number
  event: Record<string, unknown>
}): Omit<CodexWorkflowCall, 'ordinal'> & { order: string } | null {
  if (options.payload.type !== 'agent_message') return null
  const text = contentText(options.payload)
  const messageType = text.match(/^Message Type:\s*(MESSAGE|FINAL_ANSWER)\s*$/mu)?.[1]
  if (!messageType) return null
  return {
    threadId: options.identity.threadId,
    parentThreadId: options.identity.parentThreadId,
    callId: null,
    namespace: 'collaboration',
    tool: 'agent_message',
    arguments: null,
    output: {
      messageType,
      status: text.match(/\bstatus=(progress|blocked)\b/u)?.[1] ?? null,
      taskName: text.match(/^Task name:\s*(.+)\s*$/mu)?.[1] ?? null,
      senderAgentPath: text.match(/^Sender:\s*(.+)\s*$/mu)?.[1] ?? null,
      payload: messageType === 'FINAL_ANSWER' ? agentMessagePayload(text) : null,
    },
    status: 'completed',
    order: eventTimestamp(options.event, options.file, options.line),
  }
}

function normalizeToolName(value: string): { namespace: string | null; tool: string } {
  const separator = value.indexOf('__')
  return separator < 0
    ? { namespace: null, tool: value }
    : { namespace: value.slice(0, separator), tool: value.slice(separator + 2) }
}

function normalizeAppServerCollaborationTool(value: string): string {
  switch (value) {
    case 'spawnAgent':
    case 'spawn_agent':
      return 'spawn_agent'
    case 'wait':
    case 'wait_agent':
      return 'wait_agent'
    case 'closeAgent':
    case 'close_agent':
      return 'close_agent'
    default:
      return value
  }
}

function appServerCollaborationCalls(
  frames: readonly unknown[],
  records: readonly RolloutRecord[],
  descendants: ReadonlySet<string>,
): Array<Omit<CodexWorkflowCall, 'ordinal'> & { order: string }> {
  const parentByThread = new Map(records.map((record) => [record.threadId, record.parentThreadId]))
  const recordByThread = new Map(records.map((record) => [record.threadId, record]))
  const rolloutCallsById = new Map<string, RolloutRecord['calls']>()
  for (const call of records.flatMap((record) => record.calls)) {
    if (!call.callId) continue
    const matches = rolloutCallsById.get(call.callId) ?? []
    matches.push(call)
    rolloutCallsById.set(call.callId, matches)
  }
  const calls: Array<Omit<CodexWorkflowCall, 'ordinal'> & { order: string }> = []
  for (const [index, value] of frames.entries()) {
    if (!isRecord(value) || value.method !== 'item/completed') continue
    const params = isRecord(value.params) ? value.params : {}
    const item = isRecord(params.item) ? params.item : null
    if (
      !item
      || (item.type !== 'collabToolCall'
        && item.type !== 'collabAgentToolCall'
        && item.type !== 'collab_tool_call')
    ) continue
    const threadId = typeof item.senderThreadId === 'string'
      ? item.senderThreadId
      : typeof item.sender_thread_id === 'string'
        ? item.sender_thread_id
        : codexWorkflowFrameThreadId(value)
    if (!threadId || !descendants.has(threadId)) continue
    const callId = typeof item.id === 'string' && item.id !== '' ? item.id : null
    const tool = typeof item.tool === 'string' && item.tool !== '' ? item.tool : null
    const status = typeof item.status === 'string' && item.status !== '' ? item.status : null
    const receiverThreadIds = Array.isArray(item.receiverThreadIds)
      && item.receiverThreadIds.every((entry) => typeof entry === 'string')
      ? item.receiverThreadIds
      : Array.isArray(item.receiver_thread_ids)
        && item.receiver_thread_ids.every((entry) => typeof entry === 'string')
        ? item.receiver_thread_ids
        : typeof item.receiverThreadId === 'string'
          ? [item.receiverThreadId]
          : typeof item.receiver_thread_id === 'string'
            ? [item.receiver_thread_id]
          : typeof item.newThreadId === 'string'
            ? [item.newThreadId]
            : typeof item.new_thread_id === 'string'
              ? [item.new_thread_id]
            : null
    const agentsStates = item.agentsStates
      ?? item.agents_states
      ?? item.agentStatus
      ?? item.agent_status
    if (!callId || !tool || !status || !receiverThreadIds || agentsStates === undefined) {
      throw new Error('Codex app-server collaboration item is missing required terminal evidence.')
    }
    const matchingRolloutCalls = rolloutCallsById.get(callId) ?? []
    const rolloutCall = matchingRolloutCalls.length === 1 ? matchingRolloutCalls[0] : undefined
    const rolloutArguments = isRecord(rolloutCall?.arguments) ? rolloutCall.arguments : {}
    const normalizedTool = normalizeAppServerCollaborationTool(tool)
    let callArguments: unknown = rolloutCall?.arguments ?? null
    let effectiveRuntime: CodexWorkflowCall['effectiveRuntime']
    let callOutput: unknown = {
      agentsStates,
      ...(item.result !== undefined ? { result: item.result } : {}),
      ...(item.error !== undefined ? { error: item.error } : {}),
    }
    if (normalizedTool === 'spawn_agent') {
      if (matchingRolloutCalls.length !== 1 || rolloutCall?.tool !== 'spawn_agent') {
        throw new Error('Codex V1 spawn evidence must have one exact rollout call id and tool match.')
      }
      const spawnArguments = canonicalV1SpawnArguments(rolloutCall.arguments)
      if (receiverThreadIds.length !== 1) {
        throw new Error('Codex V1 spawn evidence must identify exactly one receiver thread.')
      }
      const receiverThreadId = receiverThreadIds[0]!
      const receiver = recordByThread.get(receiverThreadId)
      if (
        !receiver
        || receiver.parentThreadId !== threadId
        || !receiver.agentRole
        || !receiver.initialUserMessage
      ) throw new Error('Codex V1 spawn evidence is not linked to a plaintext child thread.')
      if (item.prompt !== undefined && item.prompt !== null && item.prompt !== receiver.initialUserMessage) {
        throw new Error('Codex V1 spawn prompt does not match the linked child thread.')
      }
      if (
        spawnArguments.agent_type !== undefined
        && spawnArguments.agent_type !== receiver.agentRole
      ) throw new Error('Codex V1 spawn role does not match the linked child thread.')
      if (
        spawnArguments.message !== receiver.initialUserMessage
      ) throw new Error('Codex V1 spawn message does not match the linked child thread.')
      const stateRecord = isRecord(agentsStates) ? agentsStates : null
      if (!stateRecord || !Object.hasOwn(stateRecord, receiverThreadId)) {
        throw new Error('Codex V1 spawn evidence is missing the linked child state.')
      }
      const model = item.model
      const reasoningEffort = item.reasoningEffort
        ?? item.reasoning_effort
      callArguments = spawnArguments
      if (
        typeof model === 'string' && model !== ''
        || typeof reasoningEffort === 'string' && reasoningEffort !== ''
      ) {
        effectiveRuntime = {
          ...(typeof model === 'string' && model !== '' ? { model } : {}),
          ...(typeof reasoningEffort === 'string' && reasoningEffort !== ''
            ? { reasoningEffort }
            : {}),
        }
      }
      callOutput = {
        agent_id: receiverThreadId,
        status: stateRecord[receiverThreadId],
      }
    } else if (normalizedTool === 'wait_agent') {
      if (!isRecord(agentsStates)) {
        throw new Error('Codex V1 wait evidence agentsStates must be an object.')
      }
      if (receiverThreadIds.some((receiver) =>
        !descendants.has(receiver)
        || !recordByThread.has(receiver)
        || !Object.hasOwn(agentsStates, receiver))) {
        throw new Error('Codex V1 wait evidence is missing a linked receiver state.')
      }
      const timeoutMs = rolloutArguments.timeout_ms
      if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 0)) {
        throw new Error('Codex V1 wait timeout_ms evidence must be a non-negative integer.')
      }
      callArguments = {
        receiver_thread_ids: receiverThreadIds,
        ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
      }
      const rawOutput = isRecord(rolloutCall?.output) ? rolloutCall.output : null
      const rawTimedOut = rawOutput?.timed_out === true
        || rawOutput?.timedOut === true
        || rawOutput?.status === 'timeout'
        || rawOutput?.status === 'timed_out'
      const result = isRecord(item.result) ? item.result : null
      const statusByReceiver: Record<string, unknown> = {}
      for (const receiver of receiverThreadIds) {
        const receiverResult = isRecord(result?.[receiver]) ? result[receiver] : result
        statusByReceiver[receiver] = receiverResult && typeof receiverResult.completed === 'string'
          ? { completed: receiverResult.completed }
          : agentsStates[receiver]
      }
      const inferredTimedOut = status === 'completed'
        && receiverThreadIds.every((receiver) => agentsStates[receiver] === 'running')
      callOutput = {
        ...(rawTimedOut || inferredTimedOut ? { timed_out: true } : {}),
        status: statusByReceiver,
      }
    } else if (normalizedTool === 'close_agent') {
      if (
        receiverThreadIds.length === 0
        || receiverThreadIds.some((receiver) =>
          !descendants.has(receiver)
          || !recordByThread.has(receiver))
      ) throw new Error('Codex V1 close evidence is missing a linked receiver thread.')
      callArguments = { receiver_thread_ids: receiverThreadIds }
    }
    calls.push({
      threadId,
      parentThreadId: parentByThread.get(threadId) ?? null,
      ...(normalizedTool === 'wait_agent'
        && receiverThreadIds.length === 1
        && recordByThread.get(receiverThreadIds[0]!)?.parentThreadId
        ? { linkedThreadId: receiverThreadIds[0]! }
        : {}),
      callId,
      namespace: 'collaboration',
      tool: normalizedTool,
      arguments: callArguments,
      ...(effectiveRuntime === undefined ? {} : { effectiveRuntime }),
      output: callOutput,
      status,
      order: `0000-app-server\0${String(index).padStart(8, '0')}`,
    })
  }
  return calls
}

function v1CodeModeSpawnCall(options: {
  events: readonly Record<string, unknown>[]
  index: number
  identity: ReturnType<typeof rolloutIdentity>
  file: string
}): Omit<CodexWorkflowCall, 'ordinal'> & { order: string } | null {
  const event = options.events[options.index]!
  const eventPayload = event.type === 'event_msg' && isRecord(event.payload) ? event.payload : null
  const item = eventPayload?.type === 'item_completed' && isRecord(eventPayload.item)
    ? eventPayload.item
    : null
  if (!item || !['CollabAgentToolCall', 'collabAgentToolCall', 'collab_tool_call'].includes(
    typeof item.type === 'string' ? item.type : '',
  )) return null
  if (normalizeAppServerCollaborationTool(String(item.tool ?? '')) !== 'spawn_agent') return null
  const previous = options.events[options.index - 1]
  const next = options.events[options.index + 1]
  const exec = previous ? responseItem(previous) : null
  const output = next ? responseItem(next) : null
  if (
    !exec
    || exec.type !== 'custom_tool_call'
    || exec.name !== 'exec'
    || typeof exec.call_id !== 'string'
    || exec.call_id === ''
    || typeof exec.input !== 'string'
    || !output
    || output.type !== 'custom_tool_call_output'
    || output.call_id !== exec.call_id
    || typeof item.id !== 'string'
    || item.id === ''
    || (item.sender_thread_id ?? item.senderThreadId) !== options.identity.threadId
  ) throw new Error('Codex V1 code-mode spawn event is not linked to its exec wrapper and output.')
  const argumentsValue = parseV1CodeModeSpawnInput(exec.input)
  if (typeof item.prompt !== 'string' || item.prompt !== argumentsValue.message) {
    throw new Error('Codex V1 code-mode spawn prompt conflicts with its wrapper arguments.')
  }
  return {
    threadId: options.identity.threadId,
    parentThreadId: options.identity.parentThreadId,
    callId: item.id,
    namespace: 'multi_agent_v1',
    tool: 'spawn_agent',
    arguments: argumentsValue,
    output: null,
    status: typeof item.status === 'string' ? item.status : null,
    order: eventTimestamp(event, options.file, options.index + 1),
  }
}

function rolloutCalls(
  events: readonly Record<string, unknown>[],
  identity: ReturnType<typeof rolloutIdentity>,
  file: string,
): Array<Omit<CodexWorkflowCall, 'ordinal'> & { order: string }> {
  const calls: Array<Omit<CodexWorkflowCall, 'ordinal'> & { order: string }> = []
  const byId = new Map<string, Omit<CodexWorkflowCall, 'ordinal'> & { order: string }>()
  const pendingOutputs = new Map<string, unknown>()
  for (const [index, event] of events.entries()) {
    const payload = responseItem(event)
    if (payload) {
      const update = agentMessageCall({ payload, identity, file, line: index + 1, event })
      if (update) calls.push(update)
      const call = callFromPayload({ payload, identity, file, line: index + 1, event })
      const v1CodeModeWrapper = isV1CodeModeExecCall(call)
      if (call && !v1CodeModeWrapper && (!call.callId || !byId.has(call.callId))) {
        if (call.callId && pendingOutputs.has(call.callId)) {
          call.output = pendingOutputs.get(call.callId)
          call.status = 'completed'
        }
        calls.push(call)
        if (call.callId) byId.set(call.callId, call)
      }
      if (
        (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')
        && typeof payload.call_id === 'string'
      ) {
        const output = parseSerialized(payload.output)
        const target = byId.get(payload.call_id)
        if (target) {
          target.output = output
          target.status = 'completed'
        } else pendingOutputs.set(payload.call_id, output)
      }
      const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
        ? payload.internal_chat_message_metadata_passthrough
        : {}
      if (Array.isArray(metadata.executed_tool_calls)) {
        if (!metadata.executed_tool_calls.every(isRecord)) {
          throw new Error('Codex executed tool-call metadata contains an invalid entry.')
        }
        if (typeof payload.call_id !== 'string' || payload.call_id === '') {
          throw new Error('Codex executed tool-call metadata is missing its output call id.')
        }
        const output = parseSerialized(payload.output)
        if (output === undefined || output === null) {
          throw new Error('Codex executed tool-call metadata is missing its linked output.')
        }
        for (const [nestedIndex, entry] of metadata.executed_tool_calls.entries()) {
          if (typeof entry.name !== 'string' || entry.name === '' || !Object.hasOwn(entry, 'arguments')) {
            throw new Error('Codex executed tool-call metadata is missing its name or arguments.')
          }
          const tool = normalizeToolName(entry.name)
          const direct = byId.get(payload.call_id)
          if (
            direct?.tool === tool.tool
            && (tool.namespace === null || direct.namespace === tool.namespace)
          ) continue
          calls.push({
            threadId: identity.threadId,
            parentThreadId: identity.parentThreadId,
            callId: metadata.executed_tool_calls.length === 1
              ? payload.call_id
              : `${payload.call_id}:executed:${nestedIndex + 1}`,
            namespace: tool.namespace,
            tool: tool.tool,
            arguments: parseSerialized(entry.arguments),
            output,
            status: 'completed',
            order: eventTimestamp(event, file, index + 1),
          })
        }
      }
    }
    const v1Spawn = v1CodeModeSpawnCall({ events, index, identity, file })
    if (v1Spawn) calls.push(v1Spawn)
    const eventPayload = event.type === 'event_msg' && isRecord(event.payload) ? event.payload : null
    const completedItem = eventPayload?.type === 'item_completed' && isRecord(eventPayload.item)
      ? eventPayload.item
      : null
    if (!completedItem) continue
    if (completedItem.type === 'CommandExecution' || completedItem.type === 'command_execution') {
      const raw = Array.isArray(completedItem.command)
        ? completedItem.command.at(-1)
        : completedItem.command
      if (typeof raw !== 'string') continue
      calls.push({
        threadId: identity.threadId,
        parentThreadId: identity.parentThreadId,
        callId: typeof completedItem.id === 'string' ? `command:${completedItem.id}` : null,
        namespace: null,
        tool: 'exec_command',
        arguments: { cmd: raw },
        output: {
          exitCode: Number.isInteger(completedItem.exit_code) ? completedItem.exit_code : null,
        },
        status: typeof completedItem.status === 'string' ? completedItem.status : 'completed',
        order: eventTimestamp(event, file, index + 1),
      })
    }
  }
  return calls
}

function initialMessages(events: readonly Record<string, unknown>[]): {
  user: string | null
  opaque: string | null
  developer: string
  developerMessageCount: number
} {
  let user: string | null = null
  let opaque: string | null = null
  const developer: string[] = []
  for (const event of events) {
    const payload = responseItem(event)
    if (!payload) continue
    if (payload.type === 'message' && payload.role === 'developer') developer.push(contentText(payload))
    if (user === null && payload.type === 'message' && payload.role === 'user') {
      const candidate = contentText(payload)
      if (candidate && !/^<environment_context>[\s\S]*<\/environment_context>$/u.test(candidate.trim())) {
        user = candidate
      }
    }
    if (opaque === null && payload.type === 'agent_message') opaque = encryptedContent(payload)
  }
  return {
    user,
    opaque,
    developer: developer.join('\n'),
    developerMessageCount: developer.length,
  }
}

function opaqueSpawnArguments(
  calls: Array<Omit<CodexWorkflowCall, 'ordinal'> & { order: string }>,
  protocol: 'v1' | 'v2',
): void {
  if (protocol !== 'v2') return
  for (const call of calls) {
    if (call.tool !== 'spawn_agent' || !isRecord(call.arguments)) continue
    if (typeof call.arguments.message !== 'string') continue
    call.arguments = {
      ...call.arguments,
      message: { kind: 'opaque', sha256: hash(call.arguments.message) },
    }
  }
}

function linkedOpaqueCall(
  calls: readonly (Omit<CodexWorkflowCall, 'ordinal'> & { order: string })[],
  parentThreadId: string,
  digest: string,
): string | null {
  const call = calls.find((entry) =>
    entry.threadId === parentThreadId
    && entry.tool === 'spawn_agent'
    && isRecord(entry.arguments)
    && isRecord(entry.arguments.message)
    && entry.arguments.message.sha256 === digest)
  return call?.callId ?? null
}

export async function normalizeCodexWorkflowRollouts(options: {
  codexHome: string
  rootThreadId: string
  request: CodexWorkflowRequest
  runtime: CodexEvalRuntimeConfig
  appServerFrames?: readonly unknown[]
  isolatedPaths?: readonly { path: string; marker: string }[]
}): Promise<{
  threadGraph: CodexWorkflowEvidence['threadGraph']
  collaborationCalls: CodexWorkflowCall[]
  leafCalls: CodexWorkflowCall[]
  skillLoads: CodexWorkflowEvidence['skillLoads']
  trace: unknown[]
}> {
  const records: RolloutRecord[] = []
  for (const { file, events } of await readCodexEvalRollouts(options.codexHome)) {
    const identity = rolloutIdentity(events)
    const messages = initialMessages(events)
    records.push({
      ...identity,
      initialUserMessage: messages.user,
      initialOpaqueMessage: messages.opaque,
      developerText: messages.developer,
      developerMessageCount: messages.developerMessageCount,
      calls: rolloutCalls(events, identity, path.relative(options.codexHome, file)),
      trace: events,
    })
  }
  const root = records.find((record) => record.threadId === options.rootThreadId)
  if (!root) throw new Error('Codex raw rollout does not contain the app-server root thread.')
  const descendants = new Set([options.rootThreadId])
  let changed = true
  while (changed) {
    changed = false
    for (const record of records) {
      if (record.parentThreadId && descendants.has(record.parentThreadId) && !descendants.has(record.threadId)) {
        descendants.add(record.threadId)
        changed = true
      }
    }
  }
  const selected = records.filter((record) => descendants.has(record.threadId))
  if (selected.some((record) => record.developerText === '')) {
    throw new Error('Codex raw rollout is missing developer context for a workflow thread.')
  }
  const rolloutCallList = selected.flatMap((record) => record.calls)
  const appServerCallList = options.request.multiAgent.protocol === 'v1'
    ? appServerCollaborationCalls(options.appServerFrames ?? [], records, descendants)
    : []
  const appServerCallIds = new Set(appServerCallList.map((call) => call.callId))
  const calls = [
    ...appServerCallList,
    ...rolloutCallList.filter((call) => !call.callId || !appServerCallIds.has(call.callId)),
  ]
  const isolatedPaths = options.isolatedPaths
    ?? [{ path: options.codexHome, marker: '[codex-home]' }]
  for (const call of calls) {
    if (
      options.request.multiAgent.protocol === 'v1'
      && isV1CodeModeExecCall(call)
      && isRecord(call.arguments)
      && typeof call.arguments.input === 'string'
    ) {
      call.arguments = {
        input: {
          namespace: 'multi_agent_v1',
          tool: 'spawn_agent',
          arguments: parseV1CodeModeSpawnInput(call.arguments.input),
        },
      }
    }
    call.arguments = sanitizeTraceValue(
      call.arguments,
      options.runtime,
      isolatedPaths,
      options.request.multiAgent.protocol === 'v2',
    )
    call.output = sanitizeTraceValue(
      call.output,
      options.runtime,
      isolatedPaths,
      options.request.multiAgent.protocol === 'v2',
    )
  }
  opaqueSpawnArguments(calls, options.request.multiAgent.protocol)
  calls.sort((left, right) => left.order.localeCompare(right.order))
  const collaborationCalls: CodexWorkflowCall[] = calls.map(({ order: _order, ...call }, index) => ({
    ...call,
    ordinal: index + 1,
  }))
  const descendantThreadIds = new Set(selected
    .filter((record) => record.threadId !== options.rootThreadId)
    .map((record) => record.threadId))
  for (const call of collaborationCalls) {
    if (call.tool !== 'wait_agent' || call.linkedThreadId !== undefined) continue
    const receiverIds = new Set<string>()
    if (isRecord(call.arguments) && Array.isArray(call.arguments.receiver_thread_ids)) {
      for (const receiver of call.arguments.receiver_thread_ids) {
        if (typeof receiver === 'string') receiverIds.add(receiver)
      }
    }
    if (isRecord(call.output) && isRecord(call.output.status)) {
      for (const receiver of Object.keys(call.output.status)) receiverIds.add(receiver)
    }
    if (receiverIds.size !== 1) continue
    const receiver = [...receiverIds][0]!
    if (descendantThreadIds.has(receiver)) call.linkedThreadId = receiver
  }
  const descendantByAgentPath = new Map<string, string | null>()
  for (const record of selected) {
    if (!record.parentThreadId || !record.agentPath) continue
    descendantByAgentPath.set(
      record.agentPath,
      descendantByAgentPath.has(record.agentPath) ? null : record.threadId,
    )
  }
  for (const call of collaborationCalls) {
    if (call.tool !== 'agent_message' || !isRecord(call.output)) continue
    const senderAgentPath = call.output.senderAgentPath
    delete call.output.senderAgentPath
    if (
      call.threadId !== options.rootThreadId
      || call.output.messageType !== 'FINAL_ANSWER'
      || typeof senderAgentPath !== 'string'
    ) continue
    const linkedThreadId = descendantByAgentPath.get(senderAgentPath)
    if (linkedThreadId) call.linkedThreadId = linkedThreadId
  }
  const threadGraph = selected.map((record) => {
    let initialMessage: CodexWorkflowEvidence['threadGraph'][number]['initialMessage'] = null
    if (record.initialOpaqueMessage) {
      const digest = hash(record.initialOpaqueMessage)
      const linkedCallId = record.parentThreadId
        ? linkedOpaqueCall(calls, record.parentThreadId, digest)
        : null
      if (!linkedCallId) throw new Error('Codex V2 child opaque message is not linked to a spawn call.')
      initialMessage = { kind: 'opaque-link', sha256: digest, linkedCallId }
    } else if (record.initialUserMessage) {
      initialMessage = { kind: 'plaintext', text: record.initialUserMessage }
    }
    if (
      record.parentThreadId
      && options.request.multiAgent.protocol === 'v1'
      && initialMessage?.kind !== 'plaintext'
    ) throw new Error('Codex V1 child rollout is missing its plaintext initial message.')
    if (
      record.parentThreadId
      && options.request.multiAgent.protocol === 'v2'
      && options.request.multiAgent.hideSpawnAgentMetadata
      && initialMessage?.kind !== 'opaque-link'
    ) throw new Error('Codex V2 child rollout is missing its opaque spawn link.')
    return {
      threadId: record.threadId,
      parentThreadId: record.parentThreadId,
      agentRole: record.agentRole,
      initialMessage,
      developerContext: {
        present: true,
        messageCount: record.developerMessageCount,
        sha256: hash(record.developerText),
        hasMultiAgentModeGate: record.developerText.includes('<multi_agent_mode>'),
        hasNestedAgentCapability: record.developerText.includes(
          'Child agents can also spawn their own sub-agents',
        ),
        hasCodexExploreDeveloperAuthorization: record.developerText.includes(
          '### Codex Explore 子代理授权',
        ),
      },
    }
  })
  threadGraph.sort((left, right) => {
    if (left.threadId === options.rootThreadId) return -1
    if (right.threadId === options.rootThreadId) return 1
    return left.threadId.localeCompare(right.threadId)
  })
  const skillLoads: CodexWorkflowEvidence['skillLoads'] = []
  const seenLoads = new Set<string>()
  for (const record of selected) {
    for (const event of record.trace) {
      const skill = selectedSkillName(event)
      if (!skill) continue
      const key = `${record.threadId}\0${skill}`
      if (seenLoads.has(key)) continue
      seenLoads.add(key)
      skillLoads.push({ threadId: record.threadId, skill, callId: null })
    }
  }
  for (const call of collaborationCalls) {
    const serialized = JSON.stringify(call.arguments).replaceAll('\\', '/')
    for (const match of serialized.matchAll(/\.agents\/skills\/([^/"\\]+)\/SKILL\.md/gu)) {
      const key = `${call.threadId}\0${match[1]}`
      if (seenLoads.has(key)) continue
      seenLoads.add(key)
      skillLoads.push({ threadId: call.threadId, skill: match[1]!, callId: call.callId })
    }
  }
  return {
    threadGraph,
    collaborationCalls,
    leafCalls: collaborationCalls.filter((call) =>
      call.threadId !== options.rootThreadId
      || (call.linkedThreadId !== undefined && descendants.has(call.linkedThreadId))),
    skillLoads,
    trace: selected.flatMap((record) => record.trace.map((event) => sanitizeTraceValue(
      isRecord(event) ? { ...event, threadId: record.threadId, parentThreadId: record.parentThreadId } : event,
      options.runtime,
      [
        ...isolatedPaths,
        ...selected.flatMap((entry) => entry.agentPath
          ? [{ path: entry.agentPath, marker: '[agent-path]' }]
          : []),
      ],
      options.request.multiAgent.protocol === 'v2',
    ))),
  }
}

function sandboxPolicy(request: CodexWorkflowRequest): Record<string, unknown> {
  // Opt-in evaluations use one outer OS profile; nesting Seatbelt is unreliable.
  if (request.evaluation) return { type: 'externalSandbox', networkAccess: 'enabled' }
  return request.sandbox === 'read-only'
    ? { type: 'readOnly', networkAccess: true }
    : {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }
}

function workflowFixtureRunner(input: CodexWorkflowTransportInput, control: CodexEvalAttemptControl) {
  return (action: WorkflowFixtureAction) => runWorkflowFixtureAction({
    action, workspace: input.input.workspacePath, fixtures: input.input.fixturesPath,
    output: input.input.outputDir, evalRoot: input.evalRoot, sourceEnv: input.sourceEnv, runtime: input.codexRuntime,
    timeoutMs: control.remaining('workflow fixture action'), signal: control.signal,
    processManagement: input.processManagement,
    ...(input.processTree ? { processTree: input.processTree } : {}),
    ...(input.protectedEvalRoots ? { protectedEvalRoots: input.protectedEvalRoots } : {}),
  })
}

async function readInstructionV2File(root: string, relative: string, limit: number): Promise<string> {
  relativeWorkspacePath(relative, 'instruction-v2 capture path')
  let target = root
  for (const part of relative.split('/')) {
    target = path.join(target, part)
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('instruction-v2 capture must not contain symbolic links.')
  }
  const stat = await fs.lstat(target)
  if (!stat.isFile() || stat.size > limit) throw new Error('instruction-v2 capture is not a bounded regular file.')
  return fs.readFile(target, 'utf8')
}

const instructionV2Transport: CodexWorkflowTransport = {
  async run(input): Promise<CodexWorkflowExecutionResult> {
    const selected = input.request.transport!
    if (!path.isAbsolute(input.codexBin)) throw new Error('instruction-v2 requires the Engine-resolved absolute Codex executable.')
    const control = new CodexEvalAttemptControl({
      label: 'instruction-v2 workflow', timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const temporaryRoot = await createCodexEvalTemporaryRoot('instruction-v2-workflow-')
    const runtimeRoot = await fs.realpath(temporaryRoot.root)
    const codexHome = path.join(runtimeRoot, 'codex-home')
    const runDirectory = path.join(runtimeRoot, 'run')
    const env: NodeJS.ProcessEnv = {
      ...buildEngineEnvironment(input.sourceEnv, runtimeRoot, codexHome, input.codexRuntime),
      AW_SUBAGENT_RUN_DIR: runDirectory,
      AW_SUBAGENT_RESULT_FILE: path.join(runDirectory, 'result.json'),
      AW_SUBAGENT_TRACE_FILE: path.join(runDirectory, 'codex-events.jsonl'),
      AW_SUBAGENT_CODEX_BINARY: input.codexBin,
    }
    const startedAt = Date.now()
    let cleaned = false
    let judgeNumber = 0
    const judgeUsage: unknown[] = []
    const grader = input.request.evaluation ? createCodexGrader({
      sourceEnv: input.sourceEnv, codexRuntime: input.codexRuntime, codexBin: input.codexBin,
      ...(input.request.model ? { model: input.request.model } : {}), processManagement: input.processManagement,
    }) : undefined
    const evaluation = input.request.evaluation ? new WorkflowEvaluation(input.request.evaluation, input.input.workspacePath, async (prompt) => {
      const outputDir = path.join(input.input.outputDir, 'workflow-judges', String(++judgeNumber))
      await fs.ensureDir(outputDir)
      const result = await grader!({ prompt, outputDir, timeoutMs: control.remaining('external semantic check'), signal: control.signal })
      if (!result.mechanicalPassed) throw new Error('external workflow semantic grader did not complete its read-only checks.')
      judgeUsage.push(result.usage)
      return parseConversationGraderOutput(result.output)
    }, workflowFixtureRunner(input, control)) : undefined
    try {
      await Promise.all([
        fs.ensureDir(env.HOME!), fs.ensureDir(env.TMPDIR!), fs.mkdir(runDirectory, { mode: 0o700 }),
        materializeCodexEvalRuntimeHome(input.codexRuntime, codexHome, { trustedProject: input.input.workspacePath }),
      ])
      await evaluation?.runSetupActions()
      const before = await snapshotWorkspace(input.input.workspacePath)
      let containment: string | undefined
      if (input.request.evaluation) {
        containment = hostReadContainmentProfile({
          forbiddenHostRoots: [input.input.fixturesPath, input.input.outputDir],
          writableRoots: [runtimeRoot, input.input.workspacePath],
          unwritableRoots: input.request.sandbox === 'read-only' ? [input.input.workspacePath] : [],
        }) + '\n' + [...new Set([input.evalRoot, ...(input.protectedEvalRoots ?? [])])].map((root) =>
          `(deny file-read* (require-all (subpath ${JSON.stringify(root)}) (require-not (subpath ${JSON.stringify(input.input.workspacePath)}))))`,
        ).join('\n')
        for (let ancestor = path.dirname(input.input.workspacePath);
          ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
          containment += `\n(allow file-read-metadata (literal ${JSON.stringify(ancestor)}))`
        }
        await assertHostReadContainmentAvailable(containment)
      }
      evaluation?.observe({ method: 'evaluation/externalSubmission', runId: selected.request.run.id }, null)
      const processResult = await runProviderProcess({
        executable: containment ? '/usr/bin/sandbox-exec' : selected.command[0],
        args: containment ? ['-p', containment, ...selected.command] : [...selected.command.slice(1)],
        cwd: input.input.workspacePath, env, stdin: JSON.stringify(selected.request),
        timeoutMs: control.remaining('external execution'), maxBufferBytes: MAX_ADAPTER_OUTPUT_BYTES,
        signal: control.signal,
      }, {}, {
        containment: input.processManagement.mode === 'unmanaged-confirmed' ? 'unmanaged-confirmed' : 'verified-observed',
        ...(input.processManagement.mode === 'unmanaged-confirmed' ? {} : { processTree: input.processTree }),
      })
      let receipt: InstructionV2Receipt | null = null
      let diagnostic: string | null = null
      try {
        receipt = parseInstructionV2Receipt(JSON.parse(await readInstructionV2File(runDirectory, 'result.json', 64 * 1024)))
      } catch (error) {
        diagnostic = `External result receipt unavailable: ${(error as Error).message}`
      }
      const trace: unknown[] = []
      if (receipt?.traceFile) {
        try {
          const raw = await readInstructionV2File(runDirectory, receipt.traceFile, 8 * 1024 * 1024)
          const lines = raw.split(/\r?\n/u).filter((line) => line.trim())
          if (lines.length > 5_000) throw new Error('instruction-v2 trace event limit exceeded.')
          for (const line of lines) trace.push(JSON.parse(line))
        } catch (error) {
          diagnostic ??= `External trace unavailable: ${(error as Error).message}`
          trace.length = 0
        }
      }
      const completed = receipt?.outcome === 'completed' && receipt.providerTerminal === 'turn.completed'
        && receipt.instructionChannel !== 'user-prefix'
        && receipt.instructionsRevision === selected.request.instructions.revision
        && processResult.exitCode === 0 && processResult.signal === null
        && !processResult.timedOut && !processResult.cancelled && !processResult.maxBufferExceeded
        && receipt.generationStarted !== false && receipt.scopeViolation !== true
        && (receipt.localExitCode === undefined || receipt.localExitCode === 0)
        && (input.processManagement.mode === 'unmanaged-confirmed' || processResult.gradingEvidenceAccepted)
        && processResult.stdout.trim() !== ''
      const status = completed ? 'completed' : receipt?.outcome === 'failed'
        && (receipt.providerTerminal === 'turn.failed' || receipt.generationStarted === false) ? 'failed' : 'unknown'
      if (!completed) diagnostic ??= 'External execution lacks compatible channel, instruction revision, terminal, normal exit, or final text evidence.'
      const after = await snapshotWorkspace(input.input.workspacePath)
      await temporaryRoot.cleanup()
      cleaned = true
      const usage = standardUsage(receipt?.usage)
      const evidence: CodexWorkflowEvidence = {
        version: 1, rootThreadId: receipt?.providerSessionId ?? selected.request.run.id,
        completion: { status, turnStatus: receipt?.providerTerminal ?? 'unknown', durationMs: Date.now() - startedAt },
        termination: {
          reason: status,
          providerProcessCleanupConfirmed: input.processManagement.mode !== 'unmanaged-confirmed'
            && processResult.gradingEvidenceAccepted,
        },
        usage, finalMessage: processResult.stdout, workspaceDiff: workspaceDiff(before, after),
        skillLoads: [], threadGraph: [], collaborationCalls: [], leafCalls: [],
        cleanup: { isolatedCodexHomeRemoved: true },
        transport: {
          type: 'instruction-v2', request: selected.request, command: selected.command, receipt,
          traceAvailable: trace.length > 0,
          observationLimits: [
            'Provider JSONL events are captured as supplied; complete file-access attribution and nested delegation coverage are not established.',
            'A file diff proves observed final content, not absence of intermediate writes. Model statements do not prove read-only behavior, independent history, or OS isolation.',
            'Provider trace is read after process exit. Artifact snapshots measure before submission and after cleanup; replayed event order does not supply intermediate snapshots.',
          ],
          diagnostic, exitCode: processResult.exitCode, signal: processResult.signal, stderr: processResult.stderr,
        },
      }
      if (completed && evaluation) {
        for (const frame of trace) evaluation.observe({ method: 'evaluation/externalTraceCapture', capturedAfterExit: true, frame }, evidence.rootThreadId)
        const messages = [
          { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: selected.request.task }] } },
          ...trace,
          { type: 'response_item', payload: { type: 'agent_message', text: processResult.stdout } },
        ]
        try {
          evidence.evaluation = await evaluation.finish(evidence, messages)
          if (!trace.length) {
            evidence.evaluation.complete = false
            evidence.evaluation.checks = evaluation.request.checks.map(({ name }) => ({
              name, verdict: 'unknown', evidence: 'External provider tool trace is unavailable; behavior assertions cannot be established from final text.',
            }))
          }
        } catch (error) {
          evidence.evaluation = {
            complete: false, checks: [], observations: evaluation.observations,
            snapshots: evaluation.snapshots, decisions: evaluation.decisions,
            fixtureActions: evaluation.fixtureActions, measurementStart: evaluation.measurementStart,
          }
          await writeWorkflowArtifacts(input.input.outputDir, redactCodexEvalValue({ evidence, trace, modelOutput: processResult.stdout, usage }, input.codexRuntime))
          throw error
        }
        const totals = [usage, ...judgeUsage].map(standardUsage)
        evidence.usage = totals.every((value) => value !== null) ? {
          inputTokens: totals.reduce((sum, value) => sum + value!.inputTokens, 0),
          outputTokens: totals.reduce((sum, value) => sum + value!.outputTokens, 0),
        } : null
      }
      return redactCodexEvalValue({ evidence, trace, modelOutput: processResult.stdout, usage: evidence.usage }, input.codexRuntime)
    } finally {
      try {
        if (!cleaned) await temporaryRoot.cleanup()
      } finally {
        control.dispose()
      }
    }
  },
}

const defaultTransport: CodexWorkflowTransport = {
  async run(input): Promise<CodexWorkflowExecutionResult> {
    const control = new CodexEvalAttemptControl({
      label: 'codex-workflow',
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const temporaryRoot = await createCodexEvalTemporaryRoot('codex-workflow-')
    const runtimeRoot = await fs.realpath(temporaryRoot.root)
    const codexHome = path.join(runtimeRoot, 'codex-home')
    const env = buildEngineEnvironment(
      input.sourceEnv,
      runtimeRoot,
      codexHome,
      input.codexRuntime,
    )
    env.AW_SUBAGENT_CODEX_BINARY = input.codexBin
    let session: EvalAppServerSession | undefined
    let cleanupConfirmed = false
    let codexHomeRemoved = false
    const startedAt = Date.now()
    const frames: unknown[] = []
    const judgeUsage: unknown[] = []
    let judgeNumber = 0
    const runGrader = input.request.evaluation ? createCodexGrader({
      sourceEnv: input.sourceEnv,
      codexRuntime: input.codexRuntime,
      codexBin: input.codexBin,
      ...(input.request.model ? { model: input.request.model } : {}),
      processManagement: input.processManagement,
    }) : undefined
    const evaluation = input.request.evaluation ? new WorkflowEvaluation(
      input.request.evaluation,
      input.input.workspacePath,
      async (prompt) => {
        const outputDir = path.join(input.input.outputDir, 'workflow-judges', String(++judgeNumber))
        await fs.ensureDir(outputDir)
        const result = await runGrader!({
          prompt, outputDir, timeoutMs: control.remaining('workflow semantic check'), signal: control.signal,
        })
        if (!result.mechanicalPassed) throw new Error('workflow semantic grader did not complete its read-only checks.')
        judgeUsage.push(result.usage)
        return parseConversationGraderOutput(result.output)
      },
      workflowFixtureRunner(input, control),
    ) : undefined
    let removeHandler: (() => void) | undefined
    let removeFailureHandler: (() => void) | undefined
    try {
      await Promise.all([
        fs.ensureDir(env.HOME!),
        fs.ensureDir(env.TMPDIR!),
        materializeCodexEvalRuntimeHome(input.codexRuntime, codexHome, {
          trustedProject: input.input.workspacePath,
        }),
      ])
      await evaluation?.runSetupActions()
      const before = await snapshotWorkspace(input.input.workspacePath)
      let containment: string | undefined
      if (evaluation) {
        containment = hostReadContainmentProfile({
          forbiddenHostRoots: [input.input.fixturesPath, input.input.outputDir],
          writableRoots: [runtimeRoot, input.input.workspacePath],
          unwritableRoots: input.request.sandbox === 'read-only' ? [input.input.workspacePath] : [],
        }) + '\n' + [...new Set([input.evalRoot, ...(input.protectedEvalRoots ?? [])])].map((root) =>
          `(deny file-read* (require-all (subpath ${JSON.stringify(root)}) (require-not (subpath ${JSON.stringify(input.input.workspacePath)}))))`,
        ).join('\n')
        for (let ancestor = path.dirname(input.input.workspacePath);
          ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
          containment += `\n(allow file-read-metadata (literal ${JSON.stringify(ancestor)}))`
        }
        await assertHostReadContainmentAvailable(containment)
      }
      const configOverrides = workflowConfig(input.request, input.input.workspacePath)
      session = new EvalAppServerSession({
        codexBin: input.codexBin,
        cwd: input.input.workspacePath,
        env,
        modelProvider: input.codexRuntime.modelProvider,
        sensitiveEnvironmentNames: input.codexRuntime.sensitiveEnvironmentNames,
        isolation: 'standard',
        processManagement: input.processManagement,
        configOverrides,
        ...(containment ? { hostReadContainmentProfile: containment } : {}),
      })
      await session.initialize(control.rpcTimeout('initialize'))
      const threadResult = await session.sendRequest('thread/start', {
        cwd: input.input.workspacePath,
        approvalPolicy: 'never',
        sandbox: input.request.sandbox,
        ephemeral: false,
        ...(input.request.model ? { model: input.request.model } : {}),
      }, control.rpcTimeout('thread/start'))
      const rootThreadId = extractAppServerThreadId(threadResult)
      let finalMessage: string | null = null
      let usage: unknown = null
      let turnStatus: string | null = null
      let resolveTurn: (() => void) | undefined
      let rejectTurn: ((error: Error) => void) | undefined
      let lastMessageOrdinal = 0
      let frameQueue = Promise.resolve()
      removeFailureHandler = session.onFailure((error) => rejectTurn?.(error))
      removeHandler = session.onFrame((frame) => {
        const isolatedPaths = [
          { path: codexHome, marker: '[codex-home]' },
          { path: env.HOME!, marker: '[isolated-home]' },
          { path: runtimeRoot, marker: '[runtime-root]' },
        ]
        frames.push(sanitizeTraceValue(
          frame,
          input.codexRuntime,
          isolatedPaths,
          input.request.multiAgent.protocol === 'v2',
        ))
        const method = typeof frame.method === 'string' ? frame.method : ''
        const params = isRecord(frame.params) ? frame.params : {}
        // Capture on receipt, before asynchronous semantic matching. All threads count.
        const ordinal = evaluation && ['item/completed', 'item/tool/requestUserInput', 'turn/completed'].includes(method)
          ? evaluation.observe(sanitizeTraceValue(frame, input.codexRuntime, isolatedPaths,
            input.request.multiAgent.protocol === 'v2'), codexWorkflowFrameThreadId(frame)) : 0
        frameQueue = frameQueue.then(async () => {
          if (method === 'turn/completed') {
            if (!codexWorkflowFrameIsForRoot(frame, rootThreadId)) return
            const turn = isRecord(params.turn) ? params.turn : {}
            turnStatus = typeof turn.status === 'string' ? turn.status : 'unknown'
            resolveTurn?.()
            return
          }
          if (!codexWorkflowFrameIsForRoot(frame, rootThreadId)) return
          if (method === 'item/completed' && isRecord(params.item)) {
            const item = params.item
            if (
              item.type === 'agentMessage'
              && item.phase === 'final_answer'
              && typeof item.text === 'string'
            ) {
              finalMessage = item.text
              lastMessageOrdinal = ordinal
            }
          }
          if (method === 'thread/tokenUsage/updated') usage = params.tokenUsage ?? usage
          if (method === 'item/tool/requestUserInput') {
            if (!evaluation) throw new Error('codex-workflow root requested interactive user input.')
            if ((typeof frame.id !== 'string' && typeof frame.id !== 'number') || !Array.isArray(params.questions)) {
              throw new Error('workflow user-input request lacks its actual id or questions.')
            }
            const reply = await evaluation.reply({ questions: params.questions }, ordinal)
            const answers = Object.fromEntries(params.questions.filter(isRecord).map((question) => [
              String(question.id), { answers: [reply && reply.questionId === question.id
                ? reply.text : 'No user decision is available for this question. Return control without dependent changes.'] },
            ]))
            await session!.respond(frame.id, { answers })
          }
          if (method === 'error') rejectTurn?.(new Error(`codex-workflow app-server error: ${JSON.stringify(params)}`))
        })
        return frameQueue
      })
      let nextPrompt = input.request.evaluation?.setupPrompt ?? input.request.prompt
      let setup = input.request.evaluation?.setupPrompt !== undefined
      while (true) {
        const turnDone = new Promise<void>((resolve, reject) => {
          resolveTurn = resolve
          rejectTurn = reject
        })
        void turnDone.catch(() => undefined)
        finalMessage = null
        turnStatus = null
        await session.sendRequest('turn/start', {
          threadId: rootThreadId,
          input: [{ type: 'text', text: nextPrompt, text_elements: [] }],
          cwd: input.input.workspacePath,
          approvalPolicy: 'never',
          sandboxPolicy: sandboxPolicy(input.request),
          ...(input.request.model ? { model: input.request.model } : {}),
        }, control.rpcTimeout('turn/start'))
        let abortTurnWait: (() => void) | undefined
        try {
          await Promise.race([
            turnDone,
            new Promise<never>((_resolve, reject) => {
              abortTurnWait = (): void => reject(control.stopError('turn wait'))
              if (control.signal.aborted) abortTurnWait()
              else control.signal.addEventListener('abort', abortTurnWait, { once: true })
            }),
          ])
        } finally {
          if (abortTurnWait) control.signal.removeEventListener('abort', abortTurnWait)
        }
        await frameQueue
        control.throwIfStopped('turn wait')
        if (turnStatus !== 'completed') {
          throw new Error(`codex-workflow root turn ended with status ${String(turnStatus)}.`)
        }
        if (!finalMessage) {
          const diagnostic = codexWorkflowMissingFinalMessageDiagnostic({
            frames,
            rootThreadId,
            turnStatus,
            usage,
          })
          throw new Error(
            `codex-workflow root turn did not produce a final message: ${JSON.stringify(diagnostic)}.`,
          )
        }
        if (setup) {
          setup = false
          evaluation!.measurementStart = evaluation!.observe({ method: 'evaluation/measurementStart' }, rootThreadId)
          nextPrompt = input.request.prompt
          continue
        }
        if (evaluation?.hasPendingDecision) {
          const reply = await evaluation.reply({ text: finalMessage }, lastMessageOrdinal)
          if (reply) {
            nextPrompt = reply.text
            continue
          }
        }
        break
      }
      const isolatedPaths = [
        { path: codexHome, marker: '[codex-home]' },
        { path: env.HOME!, marker: '[isolated-home]' },
        { path: runtimeRoot, marker: '[runtime-root]' },
      ]
      const rollout = await normalizeCodexWorkflowRollouts({
        codexHome,
        rootThreadId,
        request: input.request,
        runtime: input.codexRuntime,
        appServerFrames: frames,
        isolatedPaths,
      })
      removeHandler()
      removeHandler = undefined
      removeFailureHandler()
      removeFailureHandler = undefined
      await session.cleanup()
      cleanupConfirmed = true
      const after = await snapshotWorkspace(input.input.workspacePath)
      await temporaryRoot.cleanup()
      codexHomeRemoved = true
      const evidence: CodexWorkflowEvidence = {
        version: 1,
        rootThreadId,
        completion: {
          status: 'completed',
          turnStatus,
          durationMs: Date.now() - startedAt,
        },
        termination: {
          reason: 'completed',
          appServerProcessTreeCleanupConfirmed: true,
        },
        usage,
        finalMessage: finalMessage!,
        workspaceDiff: workspaceDiff(before, after),
        skillLoads: rollout.skillLoads,
        threadGraph: rollout.threadGraph,
        collaborationCalls: rollout.collaborationCalls,
        leafCalls: rollout.leafCalls,
        cleanup: { isolatedCodexHomeRemoved: true },
        launch: {
          instructionChannel: 'developer', developerInstructions: input.request.developerInstructions,
          instructionsRevision: createHash('sha256').update(input.request.developerInstructions).digest('hex'),
          model: input.request.model, reasoningEffort: input.request.reasoningEffort ?? null,
          sandbox: input.request.sandbox, roles: input.request.roles, configOverrides,
          hostRoleAdoption: 'unknown',
        },
      }
      if (evaluation) {
        // Subject processes are stopped before final snapshots and independent grading.
        try {
          evidence.evaluation = await evaluation.finish(evidence, rollout.trace)
        } catch (error) {
          evidence.evaluation = {
            complete: false, checks: [], observations: evaluation.observations,
            snapshots: evaluation.snapshots, decisions: evaluation.decisions,
            fixtureActions: evaluation.fixtureActions,
            measurementStart: evaluation.measurementStart,
          }
          await writeWorkflowArtifacts(input.input.outputDir, {
            evidence: session.scrub(redactCodexEvalValue(evidence, input.codexRuntime)),
            trace: session.scrub(redactCodexEvalValue([...frames, ...rollout.trace], input.codexRuntime)),
            modelOutput: redactCodexEvalValue(finalMessage!, input.codexRuntime),
            usage: redactCodexEvalValue(evidence.usage, input.codexRuntime),
          })
          throw error
        }
        const totals = [usage, ...judgeUsage].map(standardUsage)
        if (totals.some((value) => value === null)) throw new Error('workflow evaluation lacks required judge usage evidence.')
        evidence.usage = {
          inputTokens: totals.reduce((sum, value) => sum + value!.inputTokens, 0),
          outputTokens: totals.reduce((sum, value) => sum + value!.outputTokens, 0),
        }
      }
      return {
        evidence: session.scrub(redactCodexEvalValue(evidence, input.codexRuntime)),
        trace: session.scrub(redactCodexEvalValue([
          ...frames.map((frame) => sanitizeTraceValue(
            frame,
            input.codexRuntime,
            isolatedPaths,
            input.request.multiAgent.protocol === 'v2',
          )),
          ...rollout.trace,
        ], input.codexRuntime)),
        modelOutput: redactCodexEvalValue(finalMessage, input.codexRuntime),
        usage: redactCodexEvalValue(evidence.usage, input.codexRuntime),
      }
    } finally {
      removeHandler?.()
      removeFailureHandler?.()
      let cleanupError: unknown
      if (!cleanupConfirmed) {
        try {
          await session?.cleanup()
        } catch (error) {
          cleanupError = error
        }
      }
      if (!codexHomeRemoved) {
        try {
          await temporaryRoot.cleanup()
        } catch (error) {
          cleanupError ??= error
        }
      }
      control.dispose()
      if (cleanupError) {
        throw new Error(
          `codex-workflow cleanup failed: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        )
      }
    }
  },
}

function standardUsage(value: unknown): EvalProviderRunResult['usage'] {
  if (!isRecord(value)) return null
  const candidates = [value, ...['total', 'totalUsage', 'usage', 'tokenUsage']
    .map((key) => value[key]).filter(isRecord)]
  for (const candidate of candidates) {
    const input = candidate.inputTokens ?? candidate.input_tokens
    const output = candidate.outputTokens ?? candidate.output_tokens
    if (
      Number.isSafeInteger(input) && (input as number) >= 0
      && Number.isSafeInteger(output) && (output as number) >= 0
    ) return { inputTokens: input as number, outputTokens: output as number }
  }
  return null
}

async function writeWorkflowArtifacts(
  outputDir: string,
  execution: CodexWorkflowExecutionResult,
): Promise<void> {
  await Promise.all([
    fs.writeFile(
      path.join(outputDir, CODEX_WORKFLOW_ARTIFACTS[0].path),
      `${JSON.stringify(execution.evidence, null, 2)}\n`,
      { flag: 'wx' },
    ),
    fs.writeFile(
      path.join(outputDir, CODEX_WORKFLOW_ARTIFACTS[1].path),
      `${JSON.stringify(execution.trace, null, 2)}\n`,
      { flag: 'wx' },
    ),
    fs.writeFile(
      path.join(outputDir, CODEX_WORKFLOW_ARTIFACTS[2].path),
      `${execution.modelOutput}\n`,
      { flag: 'wx' },
    ),
  ])
}

async function artifactDigests(outputDir: string): Promise<string[]> {
  return Promise.all(CODEX_WORKFLOW_ARTIFACTS.map(async (artifact) =>
    hash(await fs.readFile(path.join(outputDir, artifact.path)))))
}

export async function executeCodexWorkflowProvider(
  options: CodexWorkflowExecutorOptions,
): Promise<EvalProviderRunResult & { artifacts: CodexWorkflowArtifact[] }> {
  const platform = options.platform ?? options.processTree?.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`codex-workflow is unsupported on ${platform}; no model was started.`)
  }
  const paths = await assertProviderRunPaths({
    evalRoot: options.evalRoot,
    workspacePath: options.input.workspacePath,
    fixturesPath: options.input.fixturesPath,
    outputDir: options.input.outputDir,
  })
  const sourceEnv = options.sourceEnv ?? process.env
  const processManagement = options.processManagement ?? {
    mode: 'managed',
    inspectionAvailable: true,
    userAcknowledged: false,
    descendantCleanupGuaranteed: false,
    limitation:
      'Process-tree inspection verifies cooperative descendants, but it is not OS-enforced containment and does not guarantee descendant cleanup.',
  } as const
  const control = new CodexEvalAttemptControl({
    label: 'codex-workflow provider',
    timeoutMs: options.input.timeoutMs,
    ...(options.input.signal ? { signal: options.input.signal } : {}),
  })
  try {
    const common = {
      version: 1 as const,
      case: options.input.case,
      variant: options.input.variant,
      attempt: options.input.attempt,
    }
    let prepared: Record<string, unknown>
    try {
      prepared = await runAdapter({
        command: options.provider.command,
        evalRoot: paths.evalRoot,
        input: {
          ...common,
          phase: 'prepare',
          paths: {
            workspace: paths.workspacePath,
            fixtures: paths.fixturesPath,
            output: paths.outputDir,
          },
        },
        sourceEnv,
        timeoutMs: control.remaining('prepare'),
        signal: control.signal,
        processTree: options.processTree,
        processManagement,
      })
    } catch (error) {
      control.throwIfStopped('prepare')
      throw error
    }
    const request = await parseCodexWorkflowRequest(
      prepared,
      options.provider.allowedModels,
      paths.workspacePath,
      paths.fixturesPath,
    )
    if (!request.transport && request.model === null && request.multiAgent.protocol === 'v1') {
      request.model = 'gpt-5.6-luna'
    }
    let execution: CodexWorkflowExecutionResult
    try {
      execution = await (options.transport ?? (request.transport ? instructionV2Transport : defaultTransport)).run({
        request,
        input: { ...options.input, ...paths, timeoutMs: control.remaining('Codex execution') },
        evalRoot: paths.evalRoot,
        codexRuntime: options.codexRuntime,
        codexBin: options.codexBin ?? sourceEnv.AW_SKILL_EVAL_CODEX_BIN ?? 'codex',
        sourceEnv,
        timeoutMs: control.remaining('Codex execution'),
        processManagement,
        ...(options.processTree ? { processTree: options.processTree } : {}),
        ...(options.protectedEvalRoots ? { protectedEvalRoots: options.protectedEvalRoots } : {}),
        signal: control.signal,
      })
    } catch (error) {
      control.throwIfStopped('Codex execution')
      throw error
    }
    const sanitized = redactCodexEvalValue(execution, options.codexRuntime)
    const usage = standardUsage(sanitized.usage)
    if (!request.transport && (!usage || !standardUsage(sanitized.evidence.usage))) {
      throw new Error('codex-workflow completed without required token usage evidence.')
    }
    await writeWorkflowArtifacts(paths.outputDir, sanitized)
    control.throwIfStopped('evidence collection')
    if (sanitized.evidence.completion.status !== 'completed') {
      throw new Error(`instruction-v2 workflow execution is ${sanitized.evidence.completion.status}; no grade was accepted.`)
    }
    const beforeGrade = await artifactDigests(paths.outputDir)
    let gradeValue: Record<string, unknown>
    try {
      gradeValue = await runAdapter({
        command: options.provider.command,
        evalRoot: paths.evalRoot,
        input: {
          ...common,
          phase: 'grade',
          paths: {
            workspace: paths.workspacePath,
            fixtures: paths.fixturesPath,
            output: paths.outputDir,
            evidence: path.join(paths.outputDir, CODEX_WORKFLOW_ARTIFACTS[0].path),
            modelOutput: path.join(paths.outputDir, CODEX_WORKFLOW_ARTIFACTS[2].path),
          },
        },
        sourceEnv,
        timeoutMs: control.remaining('grade'),
        signal: control.signal,
        processTree: options.processTree,
        processManagement,
      })
    } catch (error) {
      control.throwIfStopped('grade')
      throw error
    }
    const grade: EvalProviderGrade = parseEvalProviderGrade(gradeValue, 'workflow grade stdout')
    if (request.evaluation) {
      const results = sanitized.evidence.evaluation
      const required = [
        ...request.evaluation.checks,
        ...(request.evaluation.interactions.length ? [{ name: 'user-decisions', criterion: 'All required user decisions were delivered.' }] : []),
      ]
      const complete = normalizeWorkflowChecks(required, {
        passed: true, score: null, details: results,
      }).every((check) => check.verdict === 'pass')
      if (!complete) {
        grade.passed = false
        grade.score = 0
        grade.details = { ...grade.details, workflowEvidenceSatisfied: false }
      }
    }
    const afterGrade = await artifactDigests(paths.outputDir)
    if (JSON.stringify(beforeGrade) !== JSON.stringify(afterGrade)) {
      throw new Error('workflow grade modified Engine-owned attempt artifacts.')
    }
    return {
      usage,
      grade,
      artifacts: CODEX_WORKFLOW_ARTIFACTS.map((artifact) => ({ ...artifact })),
    }
  } finally {
    control.dispose()
  }
}
