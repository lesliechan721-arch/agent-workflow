import { readFile } from 'node:fs/promises'
import { validateJsonSchema } from './json-schema.js'
import type {
  Digest,
  EvalProviderCapabilities,
  EvalProviderOutput,
  SchemaName,
  ValidationResult,
} from './types.js'

const schemaNames = new Set<SchemaName>([
  'aw-skill-eval-execution-plan',
  'eval-run-bundle',
  'eval-audit-result',
  'eval-spec',
  'eval-audit',
  'eval-result',
  'eval-provider-capabilities',
  'eval-provider-output',
])

export function isSchemaName(value: string): value is SchemaName {
  return schemaNames.has(value as SchemaName)
}

export async function getSchema(name: SchemaName): Promise<Record<string, unknown>> {
  const source = new URL(`./schemas/${name}.schema.json`, import.meta.url)
  return JSON.parse(await readFile(source, 'utf8')) as Record<string, unknown>
}

export async function getSchemaDigest(name: SchemaName): Promise<Digest> {
  const digests = JSON.parse(
    await readFile(new URL('./schemas/digests.json', import.meta.url), 'utf8'),
  ) as Record<SchemaName, Digest>
  return digests[name]
}

export async function validateProviderCapabilities(
  value: unknown,
): Promise<ValidationResult<EvalProviderCapabilities>> {
  const errors = validateJsonSchema(await getSchema('eval-provider-capabilities'), value)
  return {
    valid: errors.length === 0,
    errors,
    calculated: errors.length === 0 ? value as EvalProviderCapabilities : null,
  }
}

export const validateRuntimeCapabilities = validateProviderCapabilities

export async function validateProviderOutput(
  value: unknown,
): Promise<ValidationResult<EvalProviderOutput>> {
  const errors = validateJsonSchema(await getSchema('eval-provider-output'), value)
  return {
    valid: errors.length === 0,
    errors,
    calculated: errors.length === 0 ? value as EvalProviderOutput : null,
  }
}

export async function validateAuditResult<T = unknown>(
  value: unknown,
): Promise<ValidationResult<T>> {
  const errors = validateJsonSchema(await getSchema('eval-audit-result'), value)
  return {
    valid: errors.length === 0,
    errors,
    calculated: errors.length === 0 ? value as T : null,
  }
}
