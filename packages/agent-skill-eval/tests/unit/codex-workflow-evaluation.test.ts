import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSchema, validateJsonSchema } from '../../src/index.js'

import {
  WorkflowEvaluation,
  normalizeWorkflowChecks,
  parseWorkflowEvaluation,
  readWorkflowArtifacts,
  type WorkflowEvaluationRequest,
} from '../../src/codex-workflow-evaluation.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const config: WorkflowEvaluationRequest = {
  artifacts: ['src/export.js', 'spec.md'],
  checks: [{ name: 'choice', criterion: 'Use the actual approved collection.' }],
  interactions: [{
    id: 'scope', when: 'Ask which customer collection to export.',
    answer: 'Use all authorized customers.', protectedPaths: ['src/export.js'],
  }],
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-evaluation-'))
  roots.push(root)
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src/export.js'), 'export function rows() { throw new Error("TODO") }\n')
  return root
}

describe('workflow decision and evidence boundary', () => {
  it.each([false, true])('runs final actions before independent grading and blocks failed completion (%s)', async (failed) => {
    const root = await fixture()
    const action = { command: ['node', 'verify.mjs'] as const, input: { operation: 'verify-selection' } }
    const request = { ...config, interactions: [], finalActions: [action] }
    expect(parseWorkflowEvaluation(request)).toEqual(request)
    expect(validateJsonSchema(await getSchema('workflow-evaluation'), request)).toEqual([])
    const actor = vi.fn(async () => {
      if (failed) throw new Error('Actual independent probe failed.')
      await writeFile(path.join(root, 'verification.json'), '{"tenant":true}')
      return { receipt: { version: 1 as const, completed: true as const, artifacts: ['verification.json'], evidence: { tenant: true } }, scriptSha256: '1'.repeat(64) }
    })
    const judge = vi.fn(async () => {
      expect(readWorkflowArtifacts(root, ['verification.json'])[0]!.text).toBe('{"tenant":true}')
      return { passed: true, score: 1, details: { checks: [{ name: 'choice', verdict: 'pass', evidence: 'Actual verification file.' }] } }
    })
    const evaluation = new WorkflowEvaluation(request, root, judge, actor)
    const completion = evaluation.finish({ completion: { status: 'completed' } }, [])
    if (failed) {
      await expect(completion).rejects.toThrow('Actual independent probe failed')
      expect(judge).not.toHaveBeenCalled()
    } else {
      const result = await completion
      expect(result.fixtureActions).toEqual(evaluation.fixtureActions)
      expect(evaluation.fixtureActions[0]).toMatchObject({ phase: 'final', result: { receipt: { evidence: { tenant: true } } } })
      expect(judge).toHaveBeenCalledOnce()
    }
    expect(actor).toHaveBeenCalledOnce()
    expect(() => parseWorkflowEvaluation({ ...request, finalActions: Array(9).fill(action) })).toThrow('at most 8')
  })

  it('releases a fixed fixture action only after the independent question match and records its actual files', async () => {
    const root = await fixture()
    const action = { command: ['node', 'release.mjs'] as const, input: { operation: 'release' } }
    const actor = vi.fn(async () => {
      await writeFile(path.join(root, 'later.md'), 'Actual follow-up evidence.')
      return { receipt: { version: 1 as const, completed: true as const, artifacts: ['later.md'], evidence: { filesWritten: 1 } }, scriptSha256: '1'.repeat(64) }
    })
    const request = { ...config, artifacts: [...config.artifacts, 'later.md'], interactions: [{ ...config.interactions[0]!, action }] }
    const judge = vi.fn(async () => ({ passed: true, score: 1, details: { questionId: 'text' } }))
    const evaluation = new WorkflowEvaluation(request, root, judge, actor)
    expect(readWorkflowArtifacts(root, ['later.md'])[0]!.kind).toBe('absent')
    expect(await evaluation.reply({ text: 'Which collection?' }, 1)).not.toBeNull()
    expect(actor).toHaveBeenCalledOnce()
    expect(evaluation.fixtureActions[0]).toMatchObject({ phase: 'interaction:scope', result: { receipt: { artifacts: ['later.md'] } } })
    expect(evaluation.snapshots.at(-1)!.find((file) => file.path === 'later.md')?.text).toBe('Actual follow-up evidence.')
    const rejected = new WorkflowEvaluation(request, root, async () => ({ passed: false, score: 0 }), actor)
    expect(await rejected.reply({ text: 'I finished.' }, 1)).toBeNull()
    expect(actor).toHaveBeenCalledOnce()
  })

  it('stops without an answer when a trusted fixture action fails, and marks setup actions outside measurement', async () => {
    const root = await fixture()
    const action = { command: ['node', 'setup.mjs'] as const, input: null }
    const request = { ...config, setupActions: [action], interactions: [{ ...config.interactions[0]!, action }] }
    const actor = vi.fn(async () => ({ receipt: { version: 1 as const, completed: true as const, artifacts: [], evidence: { actual: true } }, scriptSha256: '1'.repeat(64) }))
    const evaluation = new WorkflowEvaluation(request, root, async () => ({ passed: true, score: 1, details: { questionId: 'text' } }), actor)
    await evaluation.runSetupActions()
    expect(evaluation.measurementStart).toBeGreaterThan(evaluation.fixtureActions[0]!.ordinal)
    actor.mockRejectedValueOnce(new Error('Actual fixture failure.'))
    await expect(evaluation.reply({ text: 'Which collection?' }, 3)).rejects.toThrow('Actual fixture failure')
    expect(evaluation.decisions[0]).not.toHaveProperty('answer')
  })

  it('grades complete normalized calls and attributed messages without duplicating the raw rollout', async () => {
    const root = await fixture()
    const judge = vi.fn(async () => ({ passed: false, score: 0, details: {
      checks: [{ name: 'choice', verdict: 'fail', evidence: 'The observed test failed.' }],
    } }))
    const evaluation = new WorkflowEvaluation({ ...config, interactions: [] }, root, judge)
    const frame = { method: 'item/completed', params: { threadId: 'reviewer',
      item: { type: 'commandExecution', command: 'node --test', exitCode: 1, aggregatedOutput: 'Actual test failed.' } } }
    evaluation.observe(frame, 'reviewer')
    const call = { ordinal: 1, threadId: 'reviewer', parentThreadId: 'root', callId: 'test-1',
      tool: 'exec_command', arguments: { cmd: 'node --test' }, output: 'Actual test failed.', status: 'completed' }
    const evidence = { rootThreadId: 'root', finalMessage: 'Candidate claims all checks passed.',
      threadGraph: [{ threadId: 'reviewer', parentThreadId: 'root', initialMessage: { kind: 'plaintext', text: 'Review the current source independently.' } }],
      collaborationCalls: [call], leafCalls: [call] }
    const message = { type: 'response_item', threadId: 'reviewer', parentThreadId: 'root', ordinal: 4,
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The current test fails.' }] } }
    const transcript = [
      { type: 'session_meta', payload: { base_instructions: 'large runtime context '.repeat(60_000) } },
      { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'opaque-private-reasoning' } },
      { type: 'event_msg', payload: { type: 'token_count' } },
      message,
    ]
    const result = await evaluation.finish(evidence, transcript)
    const prompt = judge.mock.calls[0]![0]!
    expect(prompt.length).toBeLessThan(50_000)
    expect(prompt).not.toContain('opaque-private-reasoning')
    const candidate = JSON.parse(prompt.split('<UNTRUSTED_CANDIDATE_DATA_JSON>\n')[1]!.split('\n</UNTRUSTED_CANDIDATE_DATA_JSON>')[0]!)
    expect(JSON.parse(candidate.modelOutput)).toEqual([message])
    expect(candidate.mechanicalEvidence.evidence).toEqual({ ...evidence, leafCalls: undefined })
    expect(candidate.mechanicalEvidence.observations[0]).toMatchObject({ ordinal: 1, threadId: 'reviewer', frame })
    expect(candidate.mechanicalEvidence.snapshots[0][0].text).toContain('throw new Error')
    expect(result.checks).toEqual([{ name: 'choice', verdict: 'fail', evidence: 'The observed test failed.' }])
  })

  it('sends only the matched actual question an answer, never exposing the answer to the matcher', async () => {
    const root = await fixture()
    const judge = vi.fn(async () => ({ passed: true, score: 1, details: { questionId: 'scope-question' } }))
    const evaluation = new WorkflowEvaluation(config, root, judge)
    const question = { questions: [{ id: 'scope-question', question: 'Which collection?' }] }
    const ordinal = evaluation.observe(question, 'root')
    expect(await evaluation.reply(question, ordinal)).toEqual({ text: config.interactions[0]!.answer, questionId: 'scope-question' })
    expect(judge.mock.calls[0]?.[0]).not.toContain(config.interactions[0]!.answer)
    expect(evaluation.decisions[0]).toMatchObject({ status: 'delivered', questionOrdinal: ordinal, answerOrdinal: ordinal + 1 })
    expect(evaluation.hasPendingDecision).toBe(false)
  })

  it('does not release a hidden answer after an unrelated question or completion', async () => {
    const root = await fixture()
    const judge = vi.fn(async () => ({ passed: false, score: 0 }))
    const evaluation = new WorkflowEvaluation(config, root, judge)
    expect(await evaluation.reply({ text: 'Finished without asking.' }, 1)).toBeNull()
    expect(await evaluation.reply({ text: 'Which collection?' }, 2)).toBeNull()
    expect(judge).toHaveBeenCalledTimes(1)
    expect(evaluation.decisions[0]).not.toHaveProperty('answer')
  })

  it('rejects a fabricated question id even when the matcher says pass', async () => {
    const root = await fixture()
    const evaluation = new WorkflowEvaluation(config, root, async () => ({
      passed: true, score: 1, details: { questionId: 'fabricated' },
    }))
    expect(await evaluation.reply({ questions: [{ id: 'actual' }] }, 1)).toBeNull()
  })

  it('does not rescue a product choice written before the answer, including an observed reverted write', async () => {
    const root = await fixture()
    const judge = vi.fn(async () => ({ passed: true, score: 1, details: { questionId: 'text' } }))
    const evaluation = new WorkflowEvaluation(config, root, judge)
    await writeFile(path.join(root, 'src/export.js'), 'export const rows = []')
    evaluation.observe({ method: 'item/completed', item: 'file-change' }, 'worker')
    await writeFile(path.join(root, 'src/export.js'), 'export function rows() { throw new Error("TODO") }\n')
    expect(await evaluation.reply({ text: 'Which collection?' }, 2)).toBeNull()
    expect(judge).not.toHaveBeenCalled()
    expect(evaluation.decisions[0]!.reason).toContain('changed before decision')
  })

  it('rechecks a live writer after matching and keeps product approval distinct from a direction answer', async () => {
    const root = await fixture()
    const request = { ...config, interactions: [...config.interactions, {
      id: 'approval', when: 'Show revised Spec and request approval.', answer: 'Approved.', protectedPaths: ['src/export.js'],
    }] }
    const judge = vi.fn(async () => ({ passed: true, score: 1, details: { questionId: 'text' } }))
    const evaluation = new WorkflowEvaluation(request, root, judge)
    expect(await evaluation.reply({ text: 'Which collection?' }, 1)).not.toBeNull()
    await writeFile(path.join(root, 'spec.md'), '# Revised Spec')
    evaluation.observe({ method: 'item/completed' }, 'author')
    expect(evaluation.hasPendingDecision).toBe(true)
    await writeFile(path.join(root, 'src/export.js'), 'export const rows = []')
    expect(await evaluation.reply({ text: 'Approve current Spec?' }, 3)).toBeNull()
    expect(evaluation.decisions.map((decision) => decision.status)).toEqual(['delivered', 'rejected'])
  })

  it('blocks a concurrent product write during the semantic check', async () => {
    const root = await fixture()
    const evaluation = new WorkflowEvaluation(config, root, async () => {
      await writeFile(path.join(root, 'src/export.js'), 'changed by a live writer')
      return { passed: true, score: 1, details: { questionId: 'text' } }
    })
    expect(await evaluation.reply({ text: 'Which collection?' }, 1)).toBeNull()
    expect(evaluation.decisions[0]!.reason).toContain('while the question')
  })

  it('keeps definite failures alongside missing, duplicate and malformed semantic checks', () => {
    const required = ['behavior', 'roles', 'approval'].map((name) => ({ name, criterion: name }))
    expect(normalizeWorkflowChecks(required, { passed: true, score: 1, details: { checks: [
      { name: 'behavior', verdict: 'fail', evidence: 'Actual rows differ.' },
      { name: 'roles', verdict: 'pass', evidence: 'a' },
      { name: 'roles', verdict: 'pass', evidence: 'b' },
    ] } }).map((check) => check.verdict)).toEqual(['fail', 'unknown', 'unknown'])
  })

  it('does not follow artifact symlinks and bounds file reads', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'large.txt'), 'x'.repeat(65 * 1024))
    await symlink(path.join(root, 'src'), path.join(root, 'linked'))
    expect(readWorkflowArtifacts(root, ['linked/export.js', 'large.txt', 'missing.md']).map((file) => file.kind))
      .toEqual(['unavailable', 'unavailable', 'absent'])
    expect(() => readWorkflowArtifacts(root, ['../outside'])).toThrow('relative')
  })

  it('rejects unobserved protected paths, duplicate cases and excessive interaction budgets', () => {
    expect(() => parseWorkflowEvaluation({ ...config, artifacts: [] })).toThrow('protectedPaths')
    expect(() => parseWorkflowEvaluation({ ...config, checks: [...config.checks, ...config.checks] })).toThrow('unique')
    expect(() => parseWorkflowEvaluation({ ...config, interactions: Array(9).fill(config.interactions[0]) })).toThrow('at most 8')
  })
})
