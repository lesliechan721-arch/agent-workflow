import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js'

import schema from '../schemas/plugin-manifest-v4.json' with { type: 'json' }
import type { PluginManifestSourceV4 } from './generated/plugin-manifest-v4.js'

export type { PluginManifestSourceV4 } from './generated/plugin-manifest-v4.js'

export const PLUGIN_MANIFEST_SCHEMA_VERSION = 4 as const
export const SOURCE_PLUGIN_MANIFEST_CONTRACT_VERSION = 20

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
})
const validateV4 = ajv.compile<PluginManifestSourceV4>(schema)

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
): asserts value is PluginManifestSourceV4 {
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
  if (!validateV4(value)) {
    const issues = validateV4.errors ?? []
    throw new PluginManifestStructureError(
      `Invalid plugin manifest structure: ${issues.map(formatIssue).join('; ')}`,
      issues,
    )
  }
}

export function normalizePluginManifestSchemaVersion(
  value: unknown,
): PluginManifestSourceV4 {
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
export * from './runtime-config.js'
export * from './plugin-script-contract.js'
export * from './plugin-authoring-capabilities.js'
export * from './plugin-config.js'
export * from './aw-capabilities.js'
export * from './plugin-requirements.js'
export * from './portable-skill-validation.js'
export * from './skill-authoring.js'
export * from './skill-frontmatter-capabilities.js'
export * from './template-engine.js'
export type * from './types.js'

export * from './managed-commands.js';
export * from './native-tools.js';

export * from './plugin-components.js'

export * from './hook-handlers.js';
