import { validateJsonSchema } from '@lesliechan721/agent-skill-eval'

import checkResultSchema from '../../schemas/aw-skill-eval-check-result.schema.json' with { type: 'json' }

export const AW_SKILL_EVAL_CHECK_RESULT_SCHEMA = checkResultSchema as Record<string, unknown>

export interface AwSkillEvalCheckResult {
  schemaVersion: 1
  checker: { id: 'json-schema'; version: '1' }
  plugin: string
  skill: string
  suite: string
  profile: string
  document: { path: string; digest: `sha256:${string}` }
  schema: { path: string; digest: `sha256:${string}` }
  passed: boolean
  errors: string[]
}

export function validateAwSkillEvalCheckResult(value: unknown): string[] {
  return validateJsonSchema(AW_SKILL_EVAL_CHECK_RESULT_SCHEMA, value)
}
