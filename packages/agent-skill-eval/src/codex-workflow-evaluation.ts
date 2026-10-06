import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { EvalProviderGrade } from './custom-process.js'
import { createConversationGraderPrompt } from './providers.js'
import { parseWorkflowFixtureAction, type WorkflowFixtureAction, type WorkflowFixtureReceipt } from './codex-workflow-fixtures.js'

export interface WorkflowCheck {
  name: string
  criterion: string
}

export interface WorkflowInteraction {
  id: string
  when: string
  answer: string
  protectedPaths: string[]
  action?: WorkflowFixtureAction
}

/** Eval-owned input. This object is never added to the subject's prompt/config. */
export interface WorkflowEvaluationRequest {
  artifacts: string[]
  checks: WorkflowCheck[]
  interactions: WorkflowInteraction[]
  setupPrompt?: string
  setupActions?: WorkflowFixtureAction[]
  finalActions?: WorkflowFixtureAction[]
}

export interface WorkflowCheckResult {
  name: string
  verdict: 'pass' | 'fail' | 'unknown'
  evidence: string
}

interface Artifact {
  path: string
  kind: 'file' | 'absent' | 'unavailable'
  sha256?: string
  text?: string
}

interface Observation {
  ordinal: number
  threadId: string | null
  frame: unknown
  snapshot: number
}

interface UserDecision {
  id: string
  questionOrdinal: number
  question: unknown
  status: 'delivered' | 'rejected' | 'unknown'
  reason: string
  answer?: string
  answerOrdinal?: number
  snapshot: number
  match?: EvalProviderGrade
}

export type WorkflowJudge = (prompt: string) => Promise<EvalProviderGrade>

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains an unknown field.`)
  }
}

function text(value: unknown, label: string, max = 20_000): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) {
    throw new Error(`${label} must be non-empty bounded text.`)
  }
  return value
}

function relative(value: unknown): string {
  const file = text(value, 'evaluation artifact relative path', 1_024)
  if (file.includes('\\') || file.includes('\0') || path.posix.isAbsolute(file)
    || file.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('evaluation artifact must be a normalized relative path.')
  }
  return file
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new Error(`${label} must be an array with at most ${max} entries.`)
  }
  return value
}

export function parseWorkflowEvaluation(value: unknown): WorkflowEvaluationRequest {
  const input = object(value, 'evaluation')
  keys(input, ['artifacts', 'checks', 'interactions', 'setupPrompt', 'setupActions', 'finalActions'], 'evaluation')
  const artifacts = array(input.artifacts, 'evaluation.artifacts', 64).map(relative)
  const checks = array(input.checks, 'evaluation.checks', 64).map((entry): WorkflowCheck => {
    const check = object(entry, 'evaluation check')
    keys(check, ['name', 'criterion'], 'evaluation check')
    return { name: text(check.name, 'check.name', 200), criterion: text(check.criterion, 'check.criterion') }
  })
  const interactions = array(input.interactions, 'evaluation.interactions', 8).map((entry): WorkflowInteraction => {
    const step = object(entry, 'evaluation interaction')
    keys(step, ['id', 'when', 'answer', 'protectedPaths', 'action'], 'evaluation interaction')
    const protectedPaths = array(step.protectedPaths, 'protectedPaths', 64).map(relative)
    if (protectedPaths.some((file) => !artifacts.includes(file))) {
      throw new Error('protectedPaths must be included in evaluation.artifacts.')
    }
    return {
      id: text(step.id, 'interaction.id', 200),
      when: text(step.when, 'interaction.when'),
      answer: text(step.answer, 'interaction.answer'),
      protectedPaths,
      ...(step.action === undefined ? {} : { action: parseWorkflowFixtureAction(step.action) }),
    }
  })
  for (const [label, values] of [
    ['artifacts', artifacts], ['checks', checks.map((check) => check.name)],
    ['interactions', interactions.map((step) => step.id)],
  ] as const) {
    if (new Set(values).size !== values.length) throw new Error(`evaluation.${label} must be unique.`)
  }
  if (!checks.length) throw new Error('evaluation.checks must not be empty.')
  return {
    artifacts, checks, interactions,
    ...(input.setupPrompt === undefined ? {} : { setupPrompt: text(input.setupPrompt, 'evaluation.setupPrompt') }),
    ...(input.setupActions === undefined ? {} : { setupActions: array(input.setupActions, 'evaluation.setupActions', 8).map(parseWorkflowFixtureAction) }),
    ...(input.finalActions === undefined ? {} : { finalActions: array(input.finalActions, 'evaluation.finalActions', 8).map(parseWorkflowFixtureAction) }),
  }
}

/** Read only bounded regular files. A symlink at any path component is not followed. */
export function readWorkflowArtifacts(workspace: string, files: string[]): Artifact[] {
  let remaining = 2 * 1024 * 1024
  return files.map((file): Artifact => {
    relative(file)
    let target = workspace
    try {
      for (const part of file.split('/')) {
        target = path.join(target, part)
        if (fs.lstatSync(target).isSymbolicLink()) return { path: file, kind: 'unavailable' }
      }
      const stat = fs.lstatSync(target)
      if (!stat.isFile() || stat.size > 64 * 1024 || stat.size > remaining) {
        return { path: file, kind: 'unavailable' }
      }
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      let bytes: Buffer
      try {
        const current = fs.fstatSync(fd)
        if (!current.isFile() || current.size > 64 * 1024 || current.size > remaining) {
          return { path: file, kind: 'unavailable' }
        }
        bytes = Buffer.alloc(current.size)
        const count = fs.readSync(fd, bytes, 0, bytes.length, 0)
        bytes = bytes.subarray(0, count)
      } finally {
        fs.closeSync(fd)
      }
      remaining -= bytes.length
      return {
        path: file, kind: 'file', sha256: createHash('sha256').update(bytes).digest('hex'),
        ...(bytes.includes(0) ? {} : { text: bytes.toString('utf8') }),
      }
    } catch (error) {
      return { path: file, kind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unavailable' }
    }
  })
}

/** Missing checks and ambiguous evidence stay in the denominator. */
export function normalizeWorkflowChecks(required: WorkflowCheck[], grade: EvalProviderGrade): WorkflowCheckResult[] {
  const candidates = Array.isArray(grade.details?.checks) ? grade.details.checks : []
  return required.map(({ name }): WorkflowCheckResult => {
    const found = candidates.filter((item: unknown) => item && typeof item === 'object'
      && (item as Record<string, unknown>).name === name)
    if (found.length === 1) {
      const item = found[0] as Record<string, unknown>
      if (['pass', 'fail', 'unknown'].includes(String(item.verdict))
        && typeof item.evidence === 'string' && item.evidence.trim()) {
        return { name, verdict: item.verdict as WorkflowCheckResult['verdict'], evidence: item.evidence }
      }
    }
    return { name, verdict: 'unknown', evidence: 'Missing, duplicate, or malformed independent check.' }
  })
}

/** Per-attempt observations, not a persistent workflow or approval store. */
export class WorkflowEvaluation {
  readonly observations: Observation[] = []
  readonly snapshots: Artifact[][] = []
  readonly decisions: UserDecision[] = []
  readonly fixtureActions: Array<{ phase: string; result: unknown; ordinal: number }> = []
  measurementStart = 0
  private ordinal = 0
  private step = 0
  private stopped = false
  private observationBytes = 0

  constructor(
    readonly request: WorkflowEvaluationRequest,
    private readonly workspace: string,
    private readonly judge: WorkflowJudge,
    private readonly runAction?: (action: WorkflowFixtureAction) => Promise<{ receipt: WorkflowFixtureReceipt; scriptSha256: string }>,
  ) {
    this.capture()
  }

  private capture(): number {
    const files = readWorkflowArtifacts(this.workspace, this.request.artifacts)
    const previous = this.snapshots.at(-1)
    if (JSON.stringify(previous) !== JSON.stringify(files)) {
      if (this.snapshots.length >= 128) throw new Error('workflow artifact snapshot limit exceeded.')
      this.snapshots.push(files)
    }
    return this.snapshots.length - 1
  }

  observe(frame: unknown, threadId: string | null): number {
    const size = Buffer.byteLength(JSON.stringify(frame))
    this.observationBytes += size
    if (this.observations.length >= 5_000 || this.observationBytes > 8 * 1024 * 1024) {
      throw new Error('workflow evaluation observation limit exceeded.')
    }
    const ordinal = ++this.ordinal
    this.observations.push({ ordinal, threadId, frame, snapshot: this.capture() })
    return ordinal
  }

  get hasPendingDecision(): boolean {
    return !this.stopped && this.step < this.request.interactions.length
  }

  async runSetupActions(): Promise<void> {
    for (const action of this.request.setupActions ?? []) await this.executeAction(action, 'setup')
    if (this.request.setupActions?.length) this.measurementStart = this.observe({ method: 'evaluation/measurementStart' }, null)
  }

  private async executeAction(action: WorkflowFixtureAction, phase: string): Promise<void> {
    if (!this.runAction) throw new Error('workflow fixture action execution is unavailable.')
    const result = await this.runAction(action)
    const ordinal = this.observe({ method: 'evaluation/fixtureAction', phase, command: action.command, ...result }, null)
    this.fixtureActions.push({ phase, result, ordinal })
  }

  async reply(question: unknown, questionOrdinal: number): Promise<{ text: string; questionId: string } | null> {
    if (!this.hasPendingDecision) return null
    const step = this.request.interactions[this.step]!
    const snapshot = this.capture()
    const changes = step.protectedPaths.filter((file) => {
      const initial = this.snapshots[0]!.find((entry) => entry.path === file)
      return this.snapshots.some((files) => JSON.stringify(files.find((entry) => entry.path === file)) !== JSON.stringify(initial))
    })
    const unavailable = step.protectedPaths.some((file) => this.snapshots.some((files) =>
      files.some((entry) => entry.path === file && entry.kind === 'unavailable')))
    const decision: UserDecision = {
      id: step.id, questionOrdinal, question, snapshot,
      status: unavailable ? 'unknown' : 'rejected',
      reason: unavailable ? 'Protected artifact observation is unavailable.' : 'No relevant question established.',
    }
    this.decisions.push(decision)
    if (changes.length || unavailable) {
      decision.reason = unavailable ? decision.reason : `Protected product changed before decision: ${changes.join(', ')}.`
      this.stopped = true
      return null
    }
    const match = await this.judge(createConversationGraderPrompt({
      assertions: [
        `Return passed=true ONLY for a genuine current question or explicit confirmation request satisfying: ${step.when}`,
        'An announcement of work/completion, a proposed choice already implemented, or an unrelated question must not release an answer.',
        'Judge the meaning and presented consequences, not keywords, question marks, titles, or self-declared approval.',
        'For structured questions identify exactly one matching question. Return details.questionId with its actual id; for plain text use "text".',
        'If uncertain return passed=false. Do not answer the subject question or infer the hidden user choice.',
      ],
      modelOutput: JSON.stringify(question),
      mechanicalEvidence: { observations: this.observations, snapshots: this.snapshots, priorDecisions: this.decisions.slice(0, -1) },
    }))
    decision.match = match
    const value = question && typeof question === 'object' ? question as Record<string, unknown> : {}
    const questions = Array.isArray(value.questions) ? value.questions : null
    const questionId = match.details?.questionId
    const validId = typeof questionId === 'string' && (questions
      ? questions.some((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).id === questionId)
      : questionId === 'text')
    if (!match.passed || !validId) {
      this.stopped = true
      return null
    }
    // Recheck after the independent judge: a live writer may have changed the product.
    this.capture()
    if (step.protectedPaths.some((file) => this.snapshots.some((files) =>
      JSON.stringify(files.find((entry) => entry.path === file)) !== JSON.stringify(this.snapshots[0]!.find((entry) => entry.path === file))))) {
      decision.reason = 'Protected product changed while the question was being assessed.'
      this.stopped = true
      return null
    }
    if (step.action) {
      try {
        await this.executeAction(step.action, `interaction:${step.id}`)
      } catch (error) {
        this.stopped = true
        decision.status = 'unknown'
        decision.reason = 'Fixture action did not complete; no hidden answer was released.'
        throw error
      }
    }
    decision.status = 'delivered'
    decision.reason = 'Independent semantic match; answer supplied by Engine, not subject output.'
    decision.answer = step.answer
    decision.answerOrdinal = this.observe({ method: 'evaluation/userAnswer', id: step.id, answer: step.answer }, null)
    this.step += 1
    return { text: step.answer, questionId: questionId as string }
  }

  async finish(evidence: unknown, transcript: unknown): Promise<Record<string, unknown>> {
    this.capture()
    for (const action of this.request.finalActions ?? []) await this.executeAction(action, 'final')
    // Calls and outputs already have normalized identity/order in the evidence.
    // Keep source messages; the full rollout remains in the archived trace.
    const messages = Array.isArray(transcript) ? transcript.filter((event) => {
      if (!event || typeof event !== 'object') return false
      const entry = event as Record<string, unknown>
      if (entry.type !== 'response_item' || !entry.payload || typeof entry.payload !== 'object') return false
      return ['message', 'agent_message'].includes(String((entry.payload as Record<string, unknown>).type))
    }) : transcript
    const { leafCalls: _leafCalls, ...graderEvidence } = object(evidence, 'workflow evidence')
    const grade = await this.judge(createConversationGraderPrompt({
      assertions: [
        ...this.request.checks.map((check) => `${check.name}: ${check.criterion}`),
        'Return details.checks: [{name,verdict:"pass"|"fail"|"unknown",evidence}]. Include every named check, even when unavailable.',
        'Each result must cite actual event ordinals, thread/call identities, artifact snapshots, or concrete source content.',
        'Treat subject statements as claims, not proof. Require actual independent judgments and role/participation/order evidence, not two headings.',
        'A snapshot proves only observed content at that event. If hidden intermediate writes, task receipt, current scope, or ordering cannot be established, use unknown.',
        'Setup/imported history is not a measured action. Grader conclusions do not replace subject Review. Preserve failures alongside missing coverage.',
        'Fixture action receipts describe Eval-owned setup effects. They are not subject actions, independent model judgments, or an Oracle verdict.',
        'Engine launch evidence records submitted instructions and parameters. It does not prove that the host adopted a named role or used the requested model.',
        'An independent root may form one axis before observing the other; two clean children are also valid. A participant in authoring cannot count as an independent reviewer.',
      ],
      modelOutput: JSON.stringify(messages),
      mechanicalEvidence: {
        evidence: graderEvidence, observations: this.observations, snapshots: this.snapshots,
        decisions: this.decisions, fixtureActions: this.fixtureActions, measurementStart: this.measurementStart,
      },
    }))
    const checks = normalizeWorkflowChecks(this.request.checks, grade)
    if (this.request.interactions.length) {
      checks.push({
        name: 'user-decisions',
        verdict: this.step === this.request.interactions.length ? 'pass'
          : this.decisions.some((decision) => decision.status === 'unknown') ? 'unknown' : 'fail',
        evidence: `Engine delivered ${this.step}/${this.request.interactions.length} required decisions.`,
      })
    }
    return {
      complete: checks.every((check) => check.verdict !== 'unknown'),
      checks, decisions: this.decisions, observations: this.observations,
      snapshots: this.snapshots, fixtureActions: this.fixtureActions, measurementStart: this.measurementStart,
    }
  }
}
