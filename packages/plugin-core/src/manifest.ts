import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js'

import schema from '../schemas/plugin-manifest-v2.json' with { type: 'json' }
import type { PluginManifestSourceV2 } from './generated/plugin-manifest-v2.js'

export type { PluginManifestSourceV2 } from './generated/plugin-manifest-v2.js'

export const PLUGIN_MANIFEST_SCHEMA_VERSION = 2 as const
export const SOURCE_PLUGIN_MANIFEST_CONTRACT_VERSION = 8

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
})
const validateV2 = ajv.compile<PluginManifestSourceV2>(schema)

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
  if (
    issue.keyword === 'pattern'
    && location === '/version'
  ) {
    return `${location} must match pattern (expected a strict SemVer 2.0.0 string)`
  }
  return `${location} ${issue.message ?? 'is invalid'}`
}

export function assertPluginManifestStructure(
  value: unknown,
): asserts value is PluginManifestSourceV2 {
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
  if (!validateV2(value)) {
    const issues = validateV2.errors ?? []
    throw new PluginManifestStructureError(
      `Invalid plugin manifest structure: ${issues.map(formatIssue).join('; ')}`,
      issues,
    )
  }
}

export function normalizePluginManifestSchemaVersion(
  value: unknown,
): PluginManifestSourceV2 {
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
export * from './plugin-authoring-capabilities.js'
export * from './aw-capabilities.js'
export * from './plugin-requirements.js'
export * from './portable-skill-validation.js'
export * from './skill-authoring.js'
export * from './skill-frontmatter-capabilities.js'
export * from './slash-commands.js'
export * from './template-engine.js'
export type * from './types.js'
