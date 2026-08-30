import path from 'node:path'

import fs from 'fs-extra'

export type AwSkillEvalIsolation = 'standard' | 'strict'

export interface AwSkillEvalTriggerSuite {
  id: string
  kind: 'trigger'
  skills: string[]
  cases: string
  fixtureModule?: string
  observeSpawnAgent: boolean
  isolation: AwSkillEvalIsolation
  strictNegativeSplits: Array<'train' | 'validation' | 'sanity'>
  minimumPassRate?: number
  forbidMultipleSkillLoads: boolean
  profiles: string[]
  defaultRuns: number
  releaseSplits: Array<'train' | 'validation' | 'sanity' | 'all'>
  requiredForRelease: boolean
  perRunTimeoutMs: number
}

export const AW_SKILL_EVAL_CASE_SCHEMA_VERSION = 1 as const

export interface AwSkillEvalTriggerCase {
  id: string
  split: 'train' | 'validation' | 'sanity'
  query: string
  should_load_skill?: boolean
  expected_loaded_skills?: string[]
  should_spawn_agent?: boolean
  workspace_fixture?: string
  use_project_rules?: boolean
  tags?: string[]
}

export interface AwSkillEvalTriggerCaseDocument {
  schemaVersion: typeof AW_SKILL_EVAL_CASE_SCHEMA_VERSION
  skill: string
  cases: AwSkillEvalTriggerCase[]
}

export type AwSkillEvalTriggerSuiteCaseContract = AwSkillEvalTriggerSuite & {
  skill: string
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function onlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[], label: string): void {
  const allowed = new Set(allowedKeys)
  const unknownKey = Object.keys(value).find((key) => !allowed.has(key))
  if (unknownKey) throw new Error(`${label} has unknown field "${unknownKey}".`)
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`)
  }
  return value
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean.`)
  return value
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array.`)
  }
  return value.map((entry, index) => string(entry, `${label}[${index}]`))
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

function assertRealPathInside(
  boundary: string,
  candidate: string,
  label: string,
  boundaryLabel: string,
): void {
  const canonicalBoundary = fs.realpathSync(boundary)
  const canonicalCandidate = fs.realpathSync(candidate)
  if (!isPathInsideOrEqual(canonicalBoundary, canonicalCandidate)) {
    throw new Error(`${label} must stay inside the ${boundaryLabel}.`)
  }
}

function parseWorkspacePath(
  value: unknown,
  label: string,
  options: { allowTreePattern: boolean },
): string {
  const raw = string(value, label)
  const treePattern = options.allowTreePattern && raw.endsWith('/**')
  const candidate = treePattern ? raw.slice(0, -3) : raw
  if (
    candidate === ''
    || candidate.includes('\0')
    || candidate.includes('\\')
    || candidate.includes('*')
    || candidate.includes('?')
    || candidate.includes('[')
    || candidate.includes(']')
    || path.posix.isAbsolute(candidate)
    || path.win32.isAbsolute(candidate)
    || path.posix.normalize(candidate) !== candidate
    || candidate.split('/').includes('..')
  ) throw new Error(`${label} must be a normalized POSIX path inside the eval workspace.`)
  const firstSegment = candidate.split('/')[0]
  if (firstSegment === '.git' || firstSegment === '.agents' || firstSegment === '.codex') {
    throw new Error(`${label} must not target an eval control directory.`)
  }
  return raw
}

function workspacePathMatchesPattern(relativePath: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3)
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`)
  }
  return relativePath === pattern
}

function assertFixtureTreeSafe(fixtureRoot: string, target: string, label: string): void {
  const relativePath = path.relative(fixtureRoot, target)
  let currentPath = fixtureRoot
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment)
    if (fs.lstatSync(currentPath).isSymbolicLink()) {
      throw new Error(`${label} must not contain symbolic links.`)
    }
  }
  assertRealPathInside(fixtureRoot, target, label, 'Eval fixture root')
  const stat = fs.lstatSync(target)
  if (stat.isFile()) return
  if (!stat.isDirectory()) {
    throw new Error(`${label} must reference a regular file or directory fixture.`)
  }
  for (const entry of fs.readdirSync(target)) {
    assertFixtureTreeSafe(fixtureRoot, path.join(target, entry), label)
  }
}

function validateConversationReply(value: unknown, label: string): void {
  if (typeof value === 'string') return
  const reply = record(value, label)
  if (!Array.isArray(reply.answers_by_index) || reply.answers_by_index.some(
    (entry) => typeof entry !== 'string',
  )) throw new Error(`${label}.answers_by_index must be an array of strings.`)
  if (
    reply.expected_question_count !== undefined
    && (!Number.isInteger(reply.expected_question_count)
      || (reply.expected_question_count as number) < 0)
  ) throw new Error(`${label}.expected_question_count must be a non-negative integer.`)
  string(reply.unexpected_question_answer, `${label}.unexpected_question_answer`)
}

function validateConversationWorkspaceFiles(value: unknown, label: string): void {
  if (value === undefined) return
  const files = record(value, label)
  const entries = Object.entries(files)
  if (entries.length === 0) throw new Error(`${label} must contain at least one file.`)
  for (const [relativePath, content] of entries) {
    parseWorkspacePath(relativePath, `${label}.${relativePath}`, { allowTreePattern: false })
    string(content, `${label}.${relativePath}`)
  }
}

function targetsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function validateConversationEnvironment(
  value: unknown,
  label: string,
  fixtureRoot: string,
  occupiedTargets = new Set<string>(),
): void {
  if (value === undefined) return
  const environment = record(value, label)
  onlyKeys(environment, ['pathPrepend'], label)
  const pathPrepend = strings(environment.pathPrepend, `${label}.pathPrepend`)
    .map((entry, index) => parseWorkspacePath(
      entry,
      `${label}.pathPrepend[${index}]`,
      { allowTreePattern: false },
    ))
  if (new Set(pathPrepend).size !== pathPrepend.length) {
    throw new Error(`${label}.pathPrepend must not contain duplicates.`)
  }
  pathPrepend.forEach((relativePath, index) => {
    const absolutePath = path.resolve(fixtureRoot, relativePath)
    if (!fs.pathExistsSync(absolutePath)) {
      throw new Error(`${label}.pathPrepend[${index}] must reference an existing fixture.`)
    }
    assertFixtureTreeSafe(fixtureRoot, absolutePath, `${label}.pathPrepend[${index}]`)
    if ([...occupiedTargets].some((target) => targetsOverlap(relativePath, target))) {
      throw new Error(`${label}.pathPrepend[${index}] conflicts with another PATH fixture target.`)
    }
    occupiedTargets.add(relativePath)
  })
}

export function validateAwSkillEvalConversationCaseDocument(
  value: unknown,
  expectedSkill: string,
  label = 'conversation cases',
  fixtureRoot = process.cwd(),
  suitePathPrepend: string[] = [],
): Array<Record<string, unknown>> {
  const document = record(value, label)
  const skill = string(document.skill_name, `${label}.skill_name`)
  if (skill !== expectedSkill) {
    throw new Error(`${label}.skill_name "${skill}" does not match suite skill "${expectedSkill}".`)
  }
  if (!Array.isArray(document.evals) || document.evals.length === 0) {
    throw new Error(`${label}.evals must be a non-empty array.`)
  }
  const ids = new Set<string>()
  return document.evals.map((entry, index) => {
    const row = record(entry, `${label}.evals[${index}]`)
    const id = string(row.id, `${label}.evals[${index}].id`).trim()
    if (ids.has(id)) throw new Error(`${label} has duplicate case id "${id}".`)
    ids.add(id)
    string(row.prompt, `${label}.evals[${index}].prompt`)
    const sandbox = row.sandbox === undefined
      ? 'read-only'
      : string(row.sandbox, `${label}.evals[${index}].sandbox`)
    if (sandbox !== 'read-only' && sandbox !== 'workspace-write') {
      throw new Error(`${label}.evals[${index}].sandbox must be "read-only" or "workspace-write".`)
    }
    if (!Array.isArray(row.scripted_replies)) {
      throw new Error(`${label}.evals[${index}].scripted_replies must be an array.`)
    }
    row.scripted_replies.forEach((reply, replyIndex) => validateConversationReply(
      reply,
      `${label}.evals[${index}].scripted_replies[${replyIndex}]`,
    ))
    string(row.expected_output, `${label}.evals[${index}].expected_output`)
    validateConversationWorkspaceFiles(
      row.workspace_files,
      `${label}.evals[${index}].workspace_files`,
    )
    validateConversationEnvironment(
      row.environment,
      `${label}.evals[${index}].environment`,
      fixtureRoot,
      new Set(suitePathPrepend),
    )
    const review = record(row.review, `${label}.evals[${index}].review`)
    strings(review.checks, `${label}.evals[${index}].review.checks`)
    if (review.workspace_unchanged !== undefined) {
      boolean(review.workspace_unchanged, `${label}.evals[${index}].review.workspace_unchanged`)
    }
    const allowedWorkspaceChanges = review.allowed_workspace_changes === undefined
      ? []
      : strings(
          review.allowed_workspace_changes,
          `${label}.evals[${index}].review.allowed_workspace_changes`,
        ).map((entry, pathIndex) => parseWorkspacePath(
          entry,
          `${label}.evals[${index}].review.allowed_workspace_changes[${pathIndex}]`,
          { allowTreePattern: true },
        ))
    const artifacts = review.artifacts === undefined ? [] : review.artifacts
    if (!Array.isArray(artifacts)) {
      throw new Error(`${label}.evals[${index}].review.artifacts must be an array.`)
    }
    const artifactPaths = artifacts.map((artifact, artifactIndex) => {
      const artifactLabel = `${label}.evals[${index}].review.artifacts[${artifactIndex}]`
      const artifactRow = record(artifact, artifactLabel)
      onlyKeys(artifactRow, ['path', 'exists', 'contains', 'not_contains', 'json'], artifactLabel)
      const artifactPath = parseWorkspacePath(
        artifactRow.path,
        `${artifactLabel}.path`,
        { allowTreePattern: false },
      )
      if (artifactRow.exists !== undefined) boolean(artifactRow.exists, `${artifactLabel}.exists`)
      if (artifactRow.contains !== undefined) strings(artifactRow.contains, `${artifactLabel}.contains`)
      if (artifactRow.not_contains !== undefined) {
        strings(artifactRow.not_contains, `${artifactLabel}.not_contains`)
      }
      if (artifactRow.json !== undefined) record(artifactRow.json, `${artifactLabel}.json`)
      return artifactPath
    })
    if (new Set(artifactPaths).size !== artifactPaths.length) {
      throw new Error(`${label}.evals[${index}].review.artifacts contains duplicate paths.`)
    }
    if (sandbox === 'workspace-write') {
      if (review.workspace_unchanged !== false) {
        throw new Error(`${label}.evals[${index}] workspace-write requires review.workspace_unchanged=false.`)
      }
      if (allowedWorkspaceChanges.length === 0) {
        throw new Error(`${label}.evals[${index}] workspace-write requires non-empty review.allowed_workspace_changes.`)
      }
      if (artifactPaths.length === 0) {
        throw new Error(`${label}.evals[${index}] workspace-write requires non-empty review.artifacts.`)
      }
      const unmatchedArtifact = artifactPaths.find((artifactPath) => !allowedWorkspaceChanges.some(
        (pattern) => workspacePathMatchesPattern(artifactPath, pattern),
      ))
      if (unmatchedArtifact) {
        throw new Error(
          `${label}.evals[${index}] artifact path ${JSON.stringify(unmatchedArtifact)} `
          + 'is outside review.allowed_workspace_changes.',
        )
      }
    }
    return { ...row, id, sandbox }
  })
}

export function normalizeAwSkillEvalTriggerCase(
  value: unknown,
  index: number,
  suite: AwSkillEvalTriggerSuiteCaseContract,
): AwSkillEvalTriggerCase {
  const row = record(value, `trigger cases[${index}]`)
  const id = string(row.id, `trigger cases[${index}].id`)
  if (!/^[a-z0-9][a-z0-9_]*$/u.test(id)) {
    throw new Error(`trigger cases[${index}].id must use lowercase snake_case.`)
  }
  const split = string(row.split, `trigger cases[${index}].split`)
  if (split !== 'train' && split !== 'validation' && split !== 'sanity') {
    throw new Error(`trigger cases[${index}].split must be train, validation, or sanity.`)
  }
  const shouldSpawnAgent = row.should_spawn_agent === undefined
    ? undefined
    : boolean(row.should_spawn_agent, `trigger cases[${index}].should_spawn_agent`)
  if (suite.observeSpawnAgent && shouldSpawnAgent === undefined) {
    throw new Error(
      `trigger cases[${index}].should_spawn_agent is required when observeSpawnAgent=true.`,
    )
  }
  if (!suite.observeSpawnAgent && shouldSpawnAgent !== undefined) {
    throw new Error(`trigger cases[${index}].should_spawn_agent requires observeSpawnAgent=true.`)
  }
  const workspaceFixture = row.workspace_fixture === undefined
    ? undefined
    : string(row.workspace_fixture, `trigger cases[${index}].workspace_fixture`)
  const useProjectRules = row.use_project_rules === undefined
    ? undefined
    : boolean(row.use_project_rules, `trigger cases[${index}].use_project_rules`)
  const tags = row.tags === undefined ? undefined : strings(row.tags, `trigger cases[${index}].tags`)
  const usesLoadExpectation = row.should_load_skill !== undefined
  const usesRouteExpectation = row.expected_loaded_skills !== undefined
  if (usesLoadExpectation === usesRouteExpectation) {
    throw new Error(
      `trigger cases[${index}] must declare exactly one of should_load_skill or expected_loaded_skills.`,
    )
  }
  let expectedLoadedSkills: string[] | undefined
  if (usesRouteExpectation) {
    if (!Array.isArray(row.expected_loaded_skills)) {
      throw new Error(`trigger cases[${index}].expected_loaded_skills must be an array.`)
    }
    expectedLoadedSkills = row.expected_loaded_skills.map((entry, skillIndex) => string(
      entry,
      `trigger cases[${index}].expected_loaded_skills[${skillIndex}]`,
    ))
    if (new Set(expectedLoadedSkills).size !== expectedLoadedSkills.length) {
      throw new Error(`trigger cases[${index}].expected_loaded_skills must not contain duplicates.`)
    }
    const unknownSkill = expectedLoadedSkills.find((entry) => !suite.skills.includes(entry))
    if (unknownSkill) {
      throw new Error(
        `trigger cases[${index}].expected_loaded_skills contains non-participant Skill "${unknownSkill}".`,
      )
    }
    if (suite.forbidMultipleSkillLoads && expectedLoadedSkills.length > 1) {
      throw new Error(
        `trigger cases[${index}] expects multiple Skills but suite "${suite.id}" forbids multiple Skill loads.`,
      )
    }
  }
  return {
    id,
    split,
    query: string(row.query, `trigger cases[${index}].query`),
    ...(usesLoadExpectation
      ? { should_load_skill: boolean(row.should_load_skill, `trigger cases[${index}].should_load_skill`) }
      : { expected_loaded_skills: expectedLoadedSkills! }),
    ...(shouldSpawnAgent === undefined ? {} : { should_spawn_agent: shouldSpawnAgent }),
    ...(workspaceFixture ? { workspace_fixture: workspaceFixture } : {}),
    ...(useProjectRules === undefined ? {} : { use_project_rules: useProjectRules }),
    ...(tags ? { tags } : {}),
  }
}

export function validateAwSkillEvalTriggerCaseDocument(
  value: unknown,
  suite: AwSkillEvalTriggerSuiteCaseContract,
  label = `trigger cases for suite "${suite.id}"`,
): AwSkillEvalTriggerCaseDocument {
  const document = record(value, label)
  if (document.schemaVersion !== AW_SKILL_EVAL_CASE_SCHEMA_VERSION) {
    throw new Error(`${label} must use schemaVersion ${AW_SKILL_EVAL_CASE_SCHEMA_VERSION}.`)
  }
  const skill = string(document.skill, `${label}.skill`)
  if (skill !== suite.skill) {
    throw new Error(`trigger cases skill "${skill}" does not match suite skill "${suite.skill}".`)
  }
  if (!Array.isArray(document.cases) || document.cases.length === 0) {
    throw new Error(`${label} must contain a non-empty cases array.`)
  }
  const cases = document.cases.map((entry, index) => normalizeAwSkillEvalTriggerCase(
    entry,
    index,
    suite,
  ))
  if (new Set(cases.map((entry) => entry.id)).size !== cases.length) {
    throw new Error('Duplicate trigger case id.')
  }
  if (!suite.fixtureModule && cases.some((entry) => entry.workspace_fixture)) {
    throw new Error(
      `Trigger suite "${suite.id}" requires fixtureModule because cases declare workspace_fixture.`,
    )
  }
  for (const split of suite.releaseSplits) {
    if (split !== 'all' && !cases.some((entry) => entry.split === split)) {
      throw new Error(`Trigger suite "${suite.id}" has no cases for release split "${split}".`)
    }
  }
  return { schemaVersion: AW_SKILL_EVAL_CASE_SCHEMA_VERSION, skill, cases }
}
