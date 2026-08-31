import { readEvalContractFile } from './eval-file.js'
import {
  normalizeAwSkillEvalTriggerCase,
  type AwSkillEvalTriggerCase,
  type AwSkillEvalTriggerSuiteCaseContract,
} from './codex-eval-cases.js'
import type { ValidationResult } from './types.js'

export type SelectedCaseSuiteKind = 'trigger' | 'conversation' | 'custom-process'

export interface SelectedCaseSuite {
  kind: SelectedCaseSuiteKind
  unitUnderTest: string
  participants?: string[]
  policy?: {
    optimization?: string
    falseNegativeCost?: string
    falsePositiveCost?: string
    rationale?: string
  }
  runtime?: Record<string, unknown>
  readonly providerSuite?: AwSkillEvalTriggerSuiteCaseContract
}

export interface SelectedEvalCase extends Record<string, unknown> {
  id: string
  split: string
  tags: string[]
  readonly providerCase?: AwSkillEvalTriggerCase
}

export interface SelectedCasesDocument {
  version: 1
  suite: SelectedCaseSuite
  cases: SelectedEvalCase[]
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !keys.has(key))
  if (unknown) throw new Error(`${label} has unknown field ${JSON.stringify(unknown)}.`)
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`)
  }
  return value
}

function safeId(value: unknown, label: string): string {
  const result = nonEmptyString(value, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(result)) {
    throw new Error(`${label} must be a safe path segment.`)
  }
  return result
}

function uniqueStrings(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array.`)
  }
  const result = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`))
  if (new Set(result).size !== result.length) throw new Error(`${label} must contain unique values.`)
  return result
}

function assertJsonValue(value: unknown, label: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${label}[${index}]`))
    return
  }
  const row = record(value, label)
  for (const [key, entry] of Object.entries(row)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new Error(`${label} contains unsafe field ${JSON.stringify(key)}.`)
    }
    assertJsonValue(entry, `${label}.${key}`)
  }
}

function optionalJson(value: unknown, label: string): unknown {
  if (value !== undefined) assertJsonValue(value, label)
  return value
}

function relativePath(
  value: unknown,
  label: string,
  options: { allowTreePattern?: boolean } = {},
): string {
  const raw = nonEmptyString(value, label)
  const treePattern = options.allowTreePattern === true && raw.endsWith('/**')
  const candidate = treePattern ? raw.slice(0, -3) : raw
  if (
    candidate === ''
    || candidate.includes('\0')
    || candidate.includes('\\')
    || candidate.includes('*')
    || candidate.includes('?')
    || candidate.includes('[')
    || candidate.includes(']')
    || candidate.startsWith('/')
    || /^[A-Za-z]:/u.test(candidate)
    || candidate.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) throw new Error(`${label} must be a normalized relative POSIX path.`)
  return raw
}

function pathArray(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean; allowTreePattern?: boolean } = {},
): string[] {
  const values = uniqueStrings(value, label, options.allowEmpty === true)
  return values.map((entry, index) => relativePath(
    entry,
    `${label}[${index}]`,
    { allowTreePattern: options.allowTreePattern },
  ))
}

function triggerSuiteContract(suite: SelectedCaseSuite): AwSkillEvalTriggerSuiteCaseContract {
  const runtime = suite.runtime ?? {}
  return {
    id: 'selected',
    kind: 'trigger',
    skill: suite.unitUnderTest,
    skills: [...new Set([suite.unitUnderTest, ...(suite.participants ?? [])])],
    cases: 'cases.json',
    observeSpawnAgent: runtime.observeSpawnAgent === true,
    isolation: runtime.isolation === 'strict' ? 'strict' : 'standard',
    strictNegativeSplits: (runtime.strictNegativeSplits ?? []) as Array<'train' | 'validation' | 'sanity'>,
    forbidMultipleSkillLoads: runtime.forbidMultipleSkillLoads === true,
    ...(typeof runtime.fixture === 'string' ? { fixtureModule: runtime.fixture } : {}),
    profiles: ['selected'],
    defaultRuns: 1,
    releaseSplits: ['all'],
    requiredForRelease: false,
    perRunTimeoutMs: 1,
  }
}

function parseRuntime(
  value: unknown,
  kind: SelectedCaseSuiteKind,
): Record<string, unknown> {
  const runtime = record(value, 'selected cases.suite.runtime')
  if (kind === 'trigger') {
    onlyKeys(
      runtime,
      [
        'observeSpawnAgent',
        'isolation',
        'strictNegativeSplits',
        'forbidMultipleSkillLoads',
        'fixture',
        'minimumPassRate',
      ],
      'selected cases.suite.runtime',
    )
    if (runtime.observeSpawnAgent !== undefined && typeof runtime.observeSpawnAgent !== 'boolean') {
      throw new Error('selected cases.suite.runtime.observeSpawnAgent must be boolean.')
    }
    if (runtime.forbidMultipleSkillLoads !== undefined && typeof runtime.forbidMultipleSkillLoads !== 'boolean') {
      throw new Error('selected cases.suite.runtime.forbidMultipleSkillLoads must be boolean.')
    }
    if (runtime.isolation !== undefined && runtime.isolation !== 'standard' && runtime.isolation !== 'strict') {
      throw new Error('selected cases.suite.runtime.isolation must be standard or strict.')
    }
    if (runtime.strictNegativeSplits !== undefined) {
      const splits = uniqueStrings(
        runtime.strictNegativeSplits,
        'selected cases.suite.runtime.strictNegativeSplits',
        true,
      )
      const invalid = splits.find((split) => split !== 'train' && split !== 'validation' && split !== 'sanity')
      if (invalid) {
        throw new Error('selected cases.suite.runtime.strictNegativeSplits has an invalid split.')
      }
    }
    if (runtime.fixture !== undefined) {
      runtime.fixture = relativePath(runtime.fixture, 'selected cases.suite.runtime.fixture')
    }
  } else if (kind === 'conversation') {
    onlyKeys(runtime, ['isolation', 'pathPrepend', 'minimumPassRate'], 'selected cases.suite.runtime')
    if (runtime.isolation !== undefined && runtime.isolation !== 'standard' && runtime.isolation !== 'strict') {
      throw new Error('selected cases.suite.runtime.isolation must be standard or strict.')
    }
    runtime.pathPrepend = runtime.pathPrepend === undefined
      ? []
      : pathArray(runtime.pathPrepend, 'selected cases.suite.runtime.pathPrepend', { allowEmpty: true })
  } else {
    onlyKeys(runtime, ['minimumPassRate'], 'selected cases.suite.runtime')
  }
  if (
    runtime.minimumPassRate !== undefined
    && (
      typeof runtime.minimumPassRate !== 'number'
      || !Number.isFinite(runtime.minimumPassRate)
      || runtime.minimumPassRate < 0
      || runtime.minimumPassRate > 1
    )
  ) {
    throw new Error('selected cases.suite.runtime.minimumPassRate must be a finite number from 0 to 1.')
  }
  return runtime
}

function parseSuite(value: unknown): SelectedCaseSuite {
  const suite = record(value, 'selected cases.suite')
  onlyKeys(
    suite,
    ['kind', 'unitUnderTest', 'participants', 'policy', 'runtime'],
    'selected cases.suite',
  )
  if (suite.kind !== 'trigger' && suite.kind !== 'conversation' && suite.kind !== 'custom-process') {
    throw new Error('selected cases.suite.kind must be trigger, conversation, or custom-process.')
  }
  const result: SelectedCaseSuite = {
    kind: suite.kind,
    unitUnderTest: safeId(suite.unitUnderTest, 'selected cases.suite.unitUnderTest'),
  }
  if (suite.participants !== undefined) {
    result.participants = uniqueStrings(suite.participants, 'selected cases.suite.participants')
      .map((entry, index) => safeId(entry, `selected cases.suite.participants[${index}]`))
  }
  if (suite.policy !== undefined) {
    const policy = record(suite.policy, 'selected cases.suite.policy')
    onlyKeys(
      policy,
      ['optimization', 'falseNegativeCost', 'falsePositiveCost', 'rationale'],
      'selected cases.suite.policy',
    )
    result.policy = Object.fromEntries(Object.entries(policy).map(([key, entry]) => [
      key,
      nonEmptyString(entry, `selected cases.suite.policy.${key}`),
    ]))
  }
  if (suite.runtime !== undefined) {
    result.runtime = parseRuntime(suite.runtime, suite.kind)
  }
  if (result.kind === 'trigger') {
    Object.defineProperty(result, 'providerSuite', {
      value: triggerSuiteContract(result),
      enumerable: false,
    })
  }
  return result
}

function triggerExpectation(
  row: Record<string, unknown>,
  label: string,
): Pick<AwSkillEvalTriggerCase, 'should_load_skill' | 'expected_loaded_skills'> {
  if (row.expectedLoad !== undefined && row.expected !== undefined) {
    throw new Error(`${label} must not contain both expectedLoad and expected.`)
  }
  if (row.expectedLoad !== undefined) {
    if (typeof row.expectedLoad !== 'boolean') throw new Error(`${label}.expectedLoad must be boolean.`)
    return { should_load_skill: row.expectedLoad }
  }
  const expected = record(row.expected, `${label}.expected`)
  onlyKeys(expected, ['loadedSkills'], `${label}.expected`)
  const loadedSkills = uniqueStrings(expected.loadedSkills, `${label}.expected.loadedSkills`, true)
  return { expected_loaded_skills: loadedSkills }
}

function parseTriggerCase(
  row: Record<string, unknown>,
  index: number,
  suite: SelectedCaseSuite,
): SelectedEvalCase {
  const label = `selected cases.cases[${index}]`
  onlyKeys(
    row,
    ['id', 'split', 'tags', 'input', 'audit'],
    label,
  )
  const input = record(row.input, `${label}.input`)
  onlyKeys(
    input,
    ['query', 'expectedLoad', 'expected', 'shouldSpawnAgent', 'workspaceFixture', 'useProjectRules'],
    `${label}.input`,
  )
  const id = safeId(row.id, `${label}.id`)
  const split = safeId(row.split, `${label}.split`)
  const tags = uniqueStrings(row.tags, `${label}.tags`, true)
  const canonical = normalizeAwSkillEvalTriggerCase({
    id,
    split,
    query: nonEmptyString(input.query, `${label}.input.query`),
    ...triggerExpectation(input, `${label}.input`),
    ...(input.shouldSpawnAgent === undefined
      ? {}
      : { should_spawn_agent: input.shouldSpawnAgent }),
    ...(input.workspaceFixture === undefined
      ? {}
      : { workspace_fixture: relativePath(input.workspaceFixture, `${label}.input.workspaceFixture`) }),
    ...(input.useProjectRules === undefined
      ? {}
      : { use_project_rules: input.useProjectRules }),
    ...(tags.length === 0 ? {} : { tags }),
  }, index, suite.providerSuite!)
  if (canonical.workspace_fixture && !suite.providerSuite?.fixtureModule) {
    throw new Error(`${label}.input.workspaceFixture requires selected cases.suite.runtime.fixture.`)
  }
  const result = { ...row, id, split, tags } as SelectedEvalCase
  Object.defineProperty(result, 'providerCase', { value: canonical, enumerable: false })
  return result
}

function parseCommonAudit(row: Record<string, unknown>, label: string, tags: string[]): void {
  const audit = row.audit === undefined ? undefined : record(row.audit, `${label}.audit`)
  if (audit) {
    onlyKeys(
      audit,
      ['rationale', 'errorCost', 'allowedVariance', 'minimalCounterexample'],
      `${label}.audit`,
    )
    for (const key of ['rationale', 'allowedVariance', 'minimalCounterexample'] as const) {
      if (Object.hasOwn(audit, key)) nonEmptyString(audit[key], `${label}.audit.${key}`)
    }
    if (
      audit.errorCost !== undefined
      && audit.errorCost !== 'high'
      && audit.errorCost !== 'medium'
      && audit.errorCost !== 'low'
    ) throw new Error(`${label}.audit.errorCost must be high, medium, or low.`)
  }
  const required = [
    ...tags.some((tag) => tag === 'boundary' || tag === 'regression')
      ? ['rationale', 'minimalCounterexample']
      : [],
    ...tags.some((tag) => tag === 'release-critical' || tag === 'high-cost') ? ['errorCost'] : [],
    ...tags.includes('high-variance') ? ['allowedVariance'] : [],
  ]
  const missing = required.find((key) => !audit || !Object.hasOwn(audit, key))
  if (missing) throw new Error(`${label}.audit.${missing} is required by case tags.`)
}

function parseConversationCase(
  row: Record<string, unknown>,
  index: number,
): SelectedEvalCase {
  const label = `selected cases.cases[${index}]`
  onlyKeys(row, ['id', 'split', 'tags', 'prompt', 'assertions', 'input', 'expected', 'audit'], label)
  const id = safeId(row.id, `${label}.id`)
  const split = safeId(row.split, `${label}.split`)
  const tags = uniqueStrings(row.tags, `${label}.tags`, true)
  nonEmptyString(row.prompt, `${label}.prompt`)
  if (!Array.isArray(row.assertions) || row.assertions.length === 0) {
    throw new Error(`${label}.assertions must be a non-empty array.`)
  }
  const assertions = row.assertions.map((entry, assertionIndex) => nonEmptyString(
    entry,
    `${label}.assertions[${assertionIndex}]`,
  ))
  const input = row.input === undefined ? {} : record(row.input, `${label}.input`)
  onlyKeys(input, ['scriptedReplies', 'workspaceFiles', 'pathPrepend'], `${label}.input`)
  if (input.scriptedReplies !== undefined) {
    if (!Array.isArray(input.scriptedReplies)) {
      throw new Error(`${label}.input.scriptedReplies must be an array.`)
    }
    input.scriptedReplies.forEach((reply, replyIndex) => {
      const replyLabel = `${label}.input.scriptedReplies[${replyIndex}]`
      if (typeof reply === 'string') return
      const replyRow = record(reply, replyLabel)
      onlyKeys(
        replyRow,
        ['answersByIndex', 'expectedQuestionCount', 'unexpectedQuestionAnswer'],
        replyLabel,
      )
      if (
        !Array.isArray(replyRow.answersByIndex)
        || replyRow.answersByIndex.some((answer) => typeof answer !== 'string')
      ) throw new Error(`${replyLabel}.answersByIndex must be an array of strings.`)
      if (
        replyRow.expectedQuestionCount !== undefined
        && (
          !Number.isInteger(replyRow.expectedQuestionCount)
          || (replyRow.expectedQuestionCount as number) < 0
        )
      ) throw new Error(`${replyLabel}.expectedQuestionCount must be a non-negative integer.`)
      nonEmptyString(replyRow.unexpectedQuestionAnswer, `${replyLabel}.unexpectedQuestionAnswer`)
    })
  }
  if (input.workspaceFiles !== undefined) {
    const workspaceFiles = record(input.workspaceFiles, `${label}.input.workspaceFiles`)
    for (const [workspacePath, content] of Object.entries(workspaceFiles)) {
      relativePath(workspacePath, `${label}.input.workspaceFiles.${workspacePath}`)
      if (typeof content !== 'string') {
        throw new Error(`${label}.input.workspaceFiles.${workspacePath} must be a string.`)
      }
    }
  }
  if (input.pathPrepend !== undefined) {
    pathArray(input.pathPrepend, `${label}.input.pathPrepend`, { allowEmpty: true })
  }
  const expected = row.expected === undefined ? {} : record(row.expected, `${label}.expected`)
  onlyKeys(
    expected,
    ['output', 'workspaceUnchanged', 'allowedWorkspaceChanges', 'artifacts'],
    `${label}.expected`,
  )
  if (expected.output !== undefined) nonEmptyString(expected.output, `${label}.expected.output`)
  if (expected.workspaceUnchanged !== undefined && typeof expected.workspaceUnchanged !== 'boolean') {
    throw new Error(`${label}.expected.workspaceUnchanged must be boolean.`)
  }
  if (expected.allowedWorkspaceChanges !== undefined) {
    pathArray(
      expected.allowedWorkspaceChanges,
      `${label}.expected.allowedWorkspaceChanges`,
      { allowEmpty: true, allowTreePattern: true },
    )
  }
  if (expected.artifacts !== undefined) {
    if (!Array.isArray(expected.artifacts)) throw new Error(`${label}.expected.artifacts must be an array.`)
    optionalJson(expected.artifacts, `${label}.expected.artifacts`)
    for (const [artifactIndex, artifact] of expected.artifacts.entries()) {
      const artifactRow = record(artifact, `${label}.expected.artifacts[${artifactIndex}]`)
      onlyKeys(
        artifactRow,
        ['path', 'exists', 'contains', 'notContains', 'json'],
        `${label}.expected.artifacts[${artifactIndex}]`,
      )
      relativePath(artifactRow.path, `${label}.expected.artifacts[${artifactIndex}].path`)
    }
  }
  parseCommonAudit(row, label, tags)
  return { ...row, id, split, tags, assertions } as SelectedEvalCase
}

function parseCase(value: unknown, index: number, suite: SelectedCaseSuite): SelectedEvalCase {
  const label = `selected cases.cases[${index}]`
  const row = record(value, label)
  const common = ['id', 'split', 'tags']
  if (suite.kind === 'trigger') {
    const result = parseTriggerCase(row, index, suite)
    parseCommonAudit(row, label, result.tags)
    return result
  }
  if (suite.kind === 'conversation') return parseConversationCase(row, index)
  onlyKeys(row, [...common, 'input', 'expected', 'assertions', 'audit'], label)
  {
    optionalJson(row.input, `${label}.input`)
    optionalJson(row.expected, `${label}.expected`)
    optionalJson(row.assertions, `${label}.assertions`)
  }
  const result = {
    ...row,
    id: safeId(row.id, `${label}.id`),
    split: safeId(row.split, `${label}.split`),
    tags: uniqueStrings(row.tags, `${label}.tags`, true),
  } as SelectedEvalCase
  parseCommonAudit(row, label, result.tags)
  return result
}

export function parseSelectedCases(value: unknown): SelectedCasesDocument {
  const document = record(value, 'selected cases')
  onlyKeys(document, ['version', 'suite', 'cases'], 'selected cases')
  if (document.version !== 1) throw new Error('selected cases.version must be 1.')
  const suite = parseSuite(document.suite)
  if (!Array.isArray(document.cases) || document.cases.length === 0) {
    throw new Error('selected cases.cases must be a non-empty array.')
  }
  const cases = document.cases.map((entry, index) => parseCase(entry, index, suite))
  if (new Set(cases.map((entry) => entry.id)).size !== cases.length) {
    throw new Error('selected cases.cases must contain unique ids.')
  }
  return { version: 1, suite, cases }
}

export async function validateSelectedCases(value: unknown): Promise<ValidationResult<SelectedCasesDocument>> {
  try {
    return { valid: true, errors: [], calculated: parseSelectedCases(value) }
  } catch (error) {
    return { valid: false, errors: [(error as Error).message], calculated: null }
  }
}

export async function validateSelectedCasesFile(
  casesPath: string,
): Promise<ValidationResult<SelectedCasesDocument>> {
  try {
    const file = await readEvalContractFile(casesPath, 'selected cases')
    return validateSelectedCases(file.value)
  } catch (error) {
    return {
      valid: false,
      errors: [`Selected cases are unavailable or invalid: ${(error as Error).message}`],
      calculated: null,
    }
  }
}
