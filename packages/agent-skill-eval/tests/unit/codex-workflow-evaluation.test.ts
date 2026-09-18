import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

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
