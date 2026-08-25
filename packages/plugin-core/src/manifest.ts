import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js'

import schema from '../schemas/plugin-manifest-v1.json' with { type: 'json' }
import type { PluginManifestSourceV1 } from './generated/plugin-manifest-v1.js'

export type { PluginManifestSourceV1 } from './generated/plugin-manifest-v1.js'

export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1 as const
export const SOURCE_PLUGIN_MANIFEST_CONTRACT_VERSION = 7

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
})
const validateV1 = ajv.compile<PluginManifestSourceV1>(schema)

export class PluginManifestStructureError extends Error {
  readonly issues: ErrorObject[]

  constructor(message: string, issues: ErrorObject[] = []) {
    super(message)
    this.name = 'PluginManifestStructureError'
    this.issues = structuredClone(issues)
  }
}

function formatIssue(issue: ErrorObject): string {
  const location = issue.instancePath || '/'
  return `${location} ${issue.message ?? 'is invalid'}`
}

export function assertPluginManifestStructure(
  value: unknown,
): asserts value is PluginManifestSourceV1 {
  if (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.hasOwn(value, 'schemaVersion')
    && (value as { schemaVersion?: unknown }).schemaVersion !== PLUGIN_MANIFEST_SCHEMA_VERSION
  ) {
    throw new PluginManifestStructureError(
      `Unsupported plugin manifest schemaVersion: expected ${PLUGIN_MANIFEST_SCHEMA_VERSION}.`,
    )
  }
  if (!validateV1(value)) {
    const issues = validateV1.errors ?? []
    throw new PluginManifestStructureError(
      `Invalid plugin manifest structure: ${issues.map(formatIssue).join('; ')}`,
      issues,
    )
  }
}

export function normalizePluginManifestSchemaVersion(
  value: unknown,
): PluginManifestSourceV1 & { schemaVersion: 1 } {
  assertPluginManifestStructure(value)
  return {
    ...value,
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
  }
}

export * from './manifest-contract.js'
export * from './file-rules.js'
export * from './hooks-contract.js'
export * from './permission-command.js'
export * from './platform-entries.js'
export * from './platform-support.js'
export * from './runtime-export-source.js'
export * from './plugin-script-contract.js'
export * from './portable-skill-validation.js'
export * from './skill-authoring.js'
export * from './skill-frontmatter-capabilities.js'
export * from './slash-commands.js'
export * from './template-engine.js'
export type * from './types.js'
