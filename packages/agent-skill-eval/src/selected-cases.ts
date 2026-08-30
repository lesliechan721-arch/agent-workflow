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
  defaultGrader?: string
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
      ['observeSpawnAgent', 'isolation', 'strictNegativeSplits', 'forbidMultipleSkillLoads'],
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
  } else if (kind === 'conversation') {
    onlyKeys(runtime, ['isolation'], 'selected cases.suite.runtime')
    if (runtime.isolation !== undefined && runtime.isolation !== 'standard' && runtime.isolation !== 'strict') {
      throw new Error('selected cases.suite.runtime.isolation must be standard or strict.')
    }
  } else {
    onlyKeys(runtime, [], 'selected cases.suite.runtime')
  }
  return runtime
}

function parseSuite(value: unknown): SelectedCaseSuite {
  const suite = record(value, 'selected cases.suite')
  onlyKeys(
    suite,
    ['kind', 'unitUnderTest', 'participants', 'defaultGrader', 'policy', 'runtime'],
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
  if (suite.defaultGrader !== undefined) {
    result.defaultGrader = nonEmptyString(suite.defaultGrader, 'selected cases.suite.defaultGrader')
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
    ['id', 'split', 'tags', 'query', 'expectedLoad', 'expected', 'shouldSpawnAgent', 'input'],
    label,
  )
  const usesInput = row.input !== undefined
  const usesQuery = row.query !== undefined
  if (usesInput === usesQuery) {
    throw new Error(`${label} must contain either input or query with an expectation.`)
  }
  const input = usesInput ? record(row.input, `${label}.input`) : row
  if (usesInput) {
    onlyKeys(input, ['query', 'expectedLoad', 'expected', 'shouldSpawnAgent'], `${label}.input`)
    if (row.expectedLoad !== undefined || row.expected !== undefined || row.shouldSpawnAgent !== undefined) {
      throw new Error(`${label} must keep all trigger input fields inside input.`)
    }
  }
  const id = safeId(row.id, `${label}.id`)
  const split = safeId(row.split, `${label}.split`)
  const tags = uniqueStrings(row.tags, `${label}.tags`, true)
  const canonical = normalizeAwSkillEvalTriggerCase({
    id,
    split,
    query: nonEmptyString(input.query, `${usesInput ? `${label}.input` : label}.query`),
    ...triggerExpectation(input, usesInput ? `${label}.input` : label),
    ...(input.shouldSpawnAgent === undefined
      ? {}
      : { should_spawn_agent: input.shouldSpawnAgent }),
    ...(tags.length === 0 ? {} : { tags }),
  }, index, suite.providerSuite!)
  const result = { ...row, id, split, tags } as SelectedEvalCase
  Object.defineProperty(result, 'providerCase', { value: canonical, enumerable: false })
  return result
}

function parseCase(value: unknown, index: number, suite: SelectedCaseSuite): SelectedEvalCase {
  const label = `selected cases.cases[${index}]`
  const row = record(value, label)
  const common = ['id', 'split', 'tags']
  if (suite.kind === 'trigger') return parseTriggerCase(row, index, suite)
  if (suite.kind === 'conversation') {
    onlyKeys(row, [...common, 'prompt', 'assertions', 'audit'], label)
    nonEmptyString(row.prompt, `${label}.prompt`)
    if (!Array.isArray(row.assertions) || row.assertions.length === 0) {
      throw new Error(`${label}.assertions must be a non-empty array.`)
    }
    optionalJson(row.assertions, `${label}.assertions`)
    if (row.audit !== undefined) {
      const audit = record(row.audit, `${label}.audit`)
      onlyKeys(audit, ['allowedVariance'], `${label}.audit`)
      if (!Object.hasOwn(audit, 'allowedVariance')) {
        throw new Error(`${label}.audit.allowedVariance is required.`)
      }
      optionalJson(audit.allowedVariance, `${label}.audit.allowedVariance`)
    }
  } else {
    onlyKeys(row, [...common, 'input', 'expected', 'assertions'], label)
    optionalJson(row.input, `${label}.input`)
    optionalJson(row.expected, `${label}.expected`)
    optionalJson(row.assertions, `${label}.assertions`)
  }
  return {
    ...row,
    id: safeId(row.id, `${label}.id`),
    split: safeId(row.split, `${label}.split`),
    tags: uniqueStrings(row.tags, `${label}.tags`, true),
  } as SelectedEvalCase
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
