import { createHash } from 'node:crypto'
import path from 'node:path'

import fs from 'fs-extra'

export type InstructionV2ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface InstructionV2Request {
  protocolVersion: 2
  run: {
    id: string
    mode: 'workspace' | 'bundle'
    access: 'read-only' | 'workspace-write'
    model?: string
    reasoningEffort?: InstructionV2ReasoningEffort
    configRevision: string
    requiredIsolation?: boolean
    workspace?: string
  }
  instructions: { workerKey: string; revision: string; text: string }
  task: string
  materials: Array<{ source: string; path: string; sha256: string; startLine: number; endLine: number }>
}

export interface InstructionV2Transport {
  type: 'instruction-v2'
  command: readonly [string] | readonly [string, string]
  request: InstructionV2Request
}

export interface InstructionV2Receipt {
  protocolVersion: 2
  outcome: 'completed' | 'failed' | 'cancelled' | 'unknown'
  instructionChannel: 'system' | 'developer' | 'equivalent-config' | 'user-prefix'
  instructionsRevision: string
  providerSessionId?: string
  actualModel?: string
  providerTerminal?: string
  traceFile?: string
  adapter?: Record<string, unknown>
  usage?: unknown
  generationStarted?: boolean
  localExitCode?: number | null
  code?: string
  scopeViolation?: boolean
  remoteStopConfirmed?: false
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, required: string[], optional: string[], label: string): void {
  for (const name of required) if (!Object.hasOwn(value, name)) throw new Error(`${label} is missing ${name}.`)
  const allowed = new Set([...required, ...optional])
  for (const name of Object.keys(value)) if (!allowed.has(name)) throw new Error(`${label} has unknown field ${name}.`)
}

function text(value: unknown, label: string, maximum = 200_000): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > maximum) {
    throw new Error(`${label} must be a bounded non-empty string.`)
  }
  return value
}

function digest(value: unknown, bytes: string | Buffer, label: string): string {
  const expected = text(value, label, 71)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (expected !== actual && expected !== `sha256:${actual}`) throw new Error(`${label} does not match actual content.`)
  return expected
}

export function parseInstructionV2ReasoningEffort(value: unknown): InstructionV2ReasoningEffort {
  if (typeof value !== 'string' || !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) {
    throw new Error('workflow reasoningEffort is not supported.')
  }
  return value as InstructionV2ReasoningEffort
}

/** A trusted prepare adapter supplies this envelope; task text cannot select a command or role. */
export async function parseInstructionV2Transport(value: unknown, workspace: string): Promise<InstructionV2Transport> {
  const transport = object(value, 'workflow transport')
  keys(transport, ['type', 'command', 'request'], [], 'workflow transport')
  if (transport.type !== 'instruction-v2') throw new Error('workflow transport.type must be instruction-v2.')
  if (!Array.isArray(transport.command) || transport.command.length < 1 || transport.command.length > 2) {
    throw new Error('workflow transport.command requires an executable and at most one entrypoint.')
  }
  const command = transport.command.map((part, index) => {
    const result = text(part, `workflow transport.command[${index}]`, 4_096)
    if (!path.isAbsolute(result)) throw new Error('workflow transport.command entries must be absolute paths.')
    return result
  }) as [string] | [string, string]
  const request = object(transport.request, 'instruction-v2 request')
  keys(request, ['protocolVersion', 'run', 'instructions', 'task', 'materials'], [], 'instruction-v2 request')
  if (request.protocolVersion !== 2) throw new Error('instruction-v2 protocolVersion must be 2.')
  const run = object(request.run, 'instruction-v2 run')
  keys(run, ['id', 'mode', 'access', 'configRevision'], ['model', 'reasoningEffort', 'requiredIsolation', 'workspace'], 'instruction-v2 run')
  if (run.mode !== 'workspace' && run.mode !== 'bundle') throw new Error('instruction-v2 mode is invalid.')
  if (run.access !== 'read-only' && run.access !== 'workspace-write') throw new Error('instruction-v2 access is invalid.')
  if (run.mode === 'bundle' && run.access !== 'read-only') throw new Error('instruction-v2 bundle requires read-only access.')
  const instructions = object(request.instructions, 'instruction-v2 instructions')
  keys(instructions, ['workerKey', 'revision', 'text'], [], 'instruction-v2 instructions')
  const instructionsText = text(instructions.text, 'instruction-v2 instructions.text')
  if (!Array.isArray(request.materials) || request.materials.length > 128) throw new Error('instruction-v2 materials must have at most 128 entries.')
  let materialBytes = 0
  const materials = await Promise.all(request.materials.map(async (item) => {
    const material = object(item, 'instruction-v2 material')
    keys(material, ['source', 'path', 'sha256', 'startLine', 'endLine'], [], 'instruction-v2 material')
    const target = text(material.path, 'instruction-v2 material.path', 4_096)
    const relative = path.relative(workspace, target)
    if (!path.isAbsolute(target) || !relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('instruction-v2 material.path must be inside the subject workspace.')
    }
    let current = workspace
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment)
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('instruction-v2 material.path must not contain symbolic links.')
    }
    const info = await fs.lstat(current)
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('instruction-v2 material must be a bounded regular file.')
    const bytes = await fs.readFile(current)
    materialBytes += bytes.length
    if (materialBytes > 8 * 1024 * 1024) throw new Error('instruction-v2 material byte limit exceeded.')
    if (!Number.isSafeInteger(material.startLine) || !Number.isSafeInteger(material.endLine)
      || (material.startLine as number) < 1 || (material.endLine as number) < (material.startLine as number)) {
      throw new Error('instruction-v2 material line range is invalid.')
    }
    return {
      source: text(material.source, 'instruction-v2 material.source', 4_096), path: target,
      sha256: digest(material.sha256, bytes, 'instruction-v2 material.sha256'),
      startLine: material.startLine as number, endLine: material.endLine as number,
    }
  }))
  if (run.workspace !== undefined && run.workspace !== workspace) throw new Error('instruction-v2 workspace must equal the subject workspace.')
  if (run.requiredIsolation !== undefined && typeof run.requiredIsolation !== 'boolean') throw new Error('instruction-v2 requiredIsolation must be boolean.')
  return {
    type: 'instruction-v2', command,
    request: {
      protocolVersion: 2,
      run: {
        id: text(run.id, 'instruction-v2 run.id', 256), mode: run.mode, access: run.access,
        configRevision: text(run.configRevision, 'instruction-v2 run.configRevision', 256),
        ...(run.model === undefined ? {} : { model: text(run.model, 'instruction-v2 run.model', 256) }),
        ...(run.reasoningEffort === undefined ? {} : { reasoningEffort: parseInstructionV2ReasoningEffort(run.reasoningEffort) }),
        ...(run.requiredIsolation === undefined ? {} : { requiredIsolation: run.requiredIsolation }),
        ...(run.workspace === undefined ? {} : { workspace }),
      },
      instructions: {
        workerKey: text(instructions.workerKey, 'instruction-v2 instructions.workerKey', 256),
        revision: digest(instructions.revision, instructionsText, 'instruction-v2 instructions.revision'), text: instructionsText,
      },
      task: text(request.task, 'instruction-v2 task'), materials,
    },
  }
}

export function parseInstructionV2Receipt(value: unknown): InstructionV2Receipt {
  const receipt = object(value, 'instruction-v2 receipt')
  keys(receipt, ['protocolVersion', 'outcome', 'instructionChannel', 'instructionsRevision'],
    ['providerSessionId', 'actualModel', 'providerTerminal', 'traceFile', 'adapter', 'usage', 'generationStarted', 'localExitCode', 'code', 'scopeViolation', 'remoteStopConfirmed'], 'instruction-v2 receipt')
  if (receipt.protocolVersion !== 2 || typeof receipt.outcome !== 'string'
    || !['completed', 'failed', 'cancelled', 'unknown'].includes(receipt.outcome)
    || typeof receipt.instructionChannel !== 'string'
    || !['system', 'developer', 'equivalent-config', 'user-prefix'].includes(receipt.instructionChannel)) {
    throw new Error('instruction-v2 receipt has invalid protocol, outcome, or instruction channel.')
  }
  const result: InstructionV2Receipt = {
    protocolVersion: 2, outcome: receipt.outcome as InstructionV2Receipt['outcome'],
    instructionChannel: receipt.instructionChannel as InstructionV2Receipt['instructionChannel'],
    instructionsRevision: text(receipt.instructionsRevision, 'instruction-v2 receipt.instructionsRevision', 256),
  }
  for (const key of ['providerSessionId', 'actualModel', 'providerTerminal', 'traceFile'] as const) {
    if (receipt[key] !== undefined) result[key] = text(receipt[key], `instruction-v2 receipt.${key}`, 4_096)
  }
  if (receipt.adapter !== undefined) result.adapter = object(receipt.adapter, 'instruction-v2 receipt.adapter')
  if (receipt.usage !== undefined) result.usage = receipt.usage
  for (const key of ['generationStarted', 'scopeViolation'] as const) {
    if (receipt[key] !== undefined) {
      if (typeof receipt[key] !== 'boolean') throw new Error(`instruction-v2 receipt.${key} must be boolean.`)
      result[key] = receipt[key]
    }
  }
  if (receipt.localExitCode !== undefined) {
    if (receipt.localExitCode !== null && (!Number.isSafeInteger(receipt.localExitCode) || (receipt.localExitCode as number) < 0)) {
      throw new Error('instruction-v2 receipt.localExitCode must be a nonnegative integer or null.')
    }
    result.localExitCode = receipt.localExitCode as number | null
  }
  if (receipt.code !== undefined) result.code = text(receipt.code, 'instruction-v2 receipt.code', 256)
  if (receipt.remoteStopConfirmed !== undefined) {
    if (receipt.remoteStopConfirmed !== false) throw new Error('instruction-v2 receipt must not claim unqualified remote cancellation.')
    result.remoteStopConfirmed = false
  }
  return result
}
