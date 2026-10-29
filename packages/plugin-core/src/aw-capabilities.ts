import { createHash } from 'node:crypto'

export const AW_CAPABILITY_IDS = [
  'aw.plugin-manifest.v3',
  'aw.plugin-skills.v1',
  'aw.plugin-build-config.v1',
  'aw.plugin-config.v2',
  'aw.plugin-config.v3',
  'aw.plugin-config.v4',
  'aw.plugin-config-array.v1',
  'aw.plugin-config-unique-by.v1',
  'aw.plugin-config-value-ref.v1',
  'aw.plugin-config-summary.v1',
  'aw.plugin-pre-apply.v1',
  'aw.dynamic-artifacts.v2',
  'aw.managed-commands.v1',
  'aw.claude.sandbox-exclusions.v1',
  'aw.portable-skills.v1',
  'aw.runtime-imports.v1',
  'aw.installed-runtime-config.v2',
  'aw.skill-validation.v1',
  'aw.skill-eval.v2',
  'aw.plugin-authoring.v1',
  'aw.catalog-authoring.v1',
  'aw.catalog-source.v2',
  'aw.catalog-dev-source.v1',
  'aw.catalog-publication.v1',
  'aw.review-preparation.v1',
  'aw.review-inspection.v2',
  'aw.catalog-snapshot.v7',
  'aw.self-check.v1',
] as const

export type RegisteredAwCapabilityId = typeof AW_CAPABILITY_IDS[number]
export type AwCapabilityId = string

export interface AwCapabilitySupport {
  supported: boolean
  missing: AwCapabilityId[]
}

const CAPABILITY_ID_PATTERN = /^aw\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*\.v[1-9][0-9]*$/u
const CAPABILITY_SET_DIGEST_DOMAIN = 'aw-capability-set-v1\0'
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const STRICT_SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:0|[1-9][0-9]*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

export function assertAwCapabilityId(value: unknown, fieldName = 'capability'): asserts value is AwCapabilityId {
  if (typeof value !== 'string' || !CAPABILITY_ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${fieldName}: expected an AW capability ID.`)
  }
}

export function normalizeAwCapabilities(
  values: readonly unknown[],
  fieldName = 'capabilities',
): AwCapabilityId[] {
  const normalized = new Set<string>()
  values.forEach((value, index) => {
    assertAwCapabilityId(value, `${fieldName}[${index}]`)
    normalized.add(value)
  })
  return [...normalized].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

export function getAwCapabilityRegistry(): readonly RegisteredAwCapabilityId[] {
  const normalized = normalizeAwCapabilities(AW_CAPABILITY_IDS)
  if (normalized.length !== AW_CAPABILITY_IDS.length) {
    throw new Error('Invalid AW capability registry: capability IDs must be unique.')
  }
  return AW_CAPABILITY_IDS
}

export function computeAwCapabilitySetDigest(values: readonly unknown[]): string {
  const canonical = JSON.stringify(normalizeAwCapabilities(values))
  return `sha256:${createHash('sha256').update(CAPABILITY_SET_DIGEST_DOMAIN).update(canonical).digest('hex')}`
}

export function checkAwCapabilitySupport(
  required: readonly unknown[],
  implemented: readonly unknown[],
): AwCapabilitySupport {
  const supported = new Set(normalizeAwCapabilities(implemented, 'implementedCapabilities'))
  const missing = normalizeAwCapabilities(required, 'requiredCapabilities')
    .filter((capability) => !supported.has(capability))
  return { supported: missing.length === 0, missing }
}

export interface AwPluginRequirementsReceiptV1 {
  schemaVersion: 1
  kind: 'aw-plugin-requirements'
  plugin: { name: string; version: string }
  requiredCapabilities: AwCapabilityId[]
  digest: string
}

export function createAwPluginRequirementsReceipt(
  plugin: { name: string; version: string },
  requiredCapabilities: readonly unknown[],
): AwPluginRequirementsReceiptV1 {
  const normalized = normalizeAwCapabilities(requiredCapabilities)
  return {
    schemaVersion: 1,
    kind: 'aw-plugin-requirements',
    plugin,
    requiredCapabilities: normalized,
    digest: computeAwCapabilitySetDigest(normalized),
  }
}

function assertRecord(value: unknown, fieldName: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an object.`)
  }
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], fieldName: string): void {
  const extras = Object.keys(value).filter((key) => !keys.includes(key))
  if (extras.length > 0) throw new Error(`Invalid ${fieldName}: unknown field ${JSON.stringify(extras[0])}.`)
}

export function parseAwPluginRequirementsReceipt(value: unknown): AwPluginRequirementsReceiptV1 {
  assertRecord(value, 'AW plugin requirements receipt')
  assertExactKeys(value, ['schemaVersion', 'kind', 'plugin', 'requiredCapabilities', 'digest'], 'AW plugin requirements receipt')
  if (value.schemaVersion !== 1) throw new Error('Invalid AW plugin requirements receipt.schemaVersion: expected 1.')
  if (value.kind !== 'aw-plugin-requirements') throw new Error('Invalid AW plugin requirements receipt.kind.')
  assertRecord(value.plugin, 'AW plugin requirements receipt.plugin')
  assertExactKeys(value.plugin, ['name', 'version'], 'AW plugin requirements receipt.plugin')
  if (typeof value.plugin.name !== 'string' || !PLUGIN_NAME_PATTERN.test(value.plugin.name)) {
    throw new Error('Invalid AW plugin requirements receipt.plugin.name.')
  }
  if (typeof value.plugin.version !== 'string' || !STRICT_SEMVER_PATTERN.test(value.plugin.version)) {
    throw new Error('Invalid AW plugin requirements receipt.plugin.version.')
  }
  if (!Array.isArray(value.requiredCapabilities)) {
    throw new Error('Invalid AW plugin requirements receipt.requiredCapabilities: expected an array.')
  }
  const requiredCapabilities = normalizeAwCapabilities(
    value.requiredCapabilities,
    'AW plugin requirements receipt.requiredCapabilities',
  )
  if (typeof value.digest !== 'string' || value.digest !== computeAwCapabilitySetDigest(requiredCapabilities)) {
    throw new Error('Invalid AW plugin requirements receipt.digest.')
  }
  return {
    schemaVersion: 1,
    kind: 'aw-plugin-requirements',
    plugin: { name: value.plugin.name, version: value.plugin.version },
    requiredCapabilities,
    digest: value.digest,
  }
}
