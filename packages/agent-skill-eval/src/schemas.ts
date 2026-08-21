import { readFile } from 'node:fs/promises'
import { validateJsonSchema } from './json-schema.js'
import type {
  Digest,
  RuntimeCapabilities,
  SchemaName,
  ValidationResult,
} from './types.js'

const schemaNames = new Set<SchemaName>([
  'eval-execution-plan',
  'eval-run-bundle',
  'eval-audit-result',
  'eval-runtime-capabilities',
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

export async function validateRuntimeCapabilities(
  value: unknown,
): Promise<ValidationResult<RuntimeCapabilities>> {
  const errors = validateJsonSchema(await getSchema('eval-runtime-capabilities'), value)
  return {
    valid: errors.length === 0,
    errors,
    calculated: errors.length === 0 ? value as RuntimeCapabilities : null,
  }
}
