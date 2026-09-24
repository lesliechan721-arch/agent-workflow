import crypto from 'node:crypto'

import { canonicalJson } from '@lesliechan721/agent-skill-eval'
import {
  canonicalizePluginConfigValues,
  formatPluginConfigIssue,
  validatePluginConfigDocument,
  validatePluginConfigValue,
  type PluginConfigValue,
  type PluginMeta,
  type Scope,
} from '@lesliechan721/aw-plugin-core'

import type { PluginConfigSource } from '../utils/plugin-config.js'
import {
  ReviewSelectionError,
  type ReviewPlatform,
  type ReviewPluginProfileConfig,
  type ReviewProfile,
  type ReviewProfileConfig,
  type ReviewSelectedSkill,
} from './review-types.js'

const digestPattern = /^sha256:[0-9a-f]{64}$/u
const safeIdPattern = /^[a-z0-9][a-z0-9-]*$/u
const safeConfigKeyPattern = /^[A-Za-z][A-Za-z0-9_]*$/u
const dangerousConfigKeys = new Set(['__proto__', 'constructor', 'prototype'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function digestCanonical(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function sameConfigValue(left: PluginConfigValue, right: PluginConfigValue): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function assertConfigValueShape(value: unknown, field: string): PluginConfigValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) {
      throw new Error(`Review profile config field "${field}" has an invalid array value.`)
    }
    const items = value.map((item) => {
      if (Array.isArray(item)) {
        throw new Error(`Review profile config field "${field}" has an invalid array value.`)
      }
      return assertConfigValueShape(item, field)
    })
    const itemType = items[0] !== null && typeof items[0] === 'object' ? 'object' : typeof items[0]
    if (items.some((item) => (typeof item === 'object' ? 'object' : typeof item) !== itemType)) {
      throw new Error(`Review profile config field "${field}" has an invalid array value.`)
    }
    return items as unknown as PluginConfigValue
  }
  if (!isRecord(value)) {
    throw new Error(`Review profile config field "${field}" has an invalid value.`)
  }
  const result: Record<string, string | number | boolean> = {}
  for (const [key, child] of Object.entries(value)) {
    if (
      dangerousConfigKeys.has(key)
      || !(
        typeof child === 'string'
        || typeof child === 'boolean'
        || (typeof child === 'number' && Number.isFinite(child))
      )
    ) throw new Error(`Review profile config field "${field}" has an invalid object value.`)
    result[key] = child
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => compareText(left, right)))
}

export function normalizeReviewProfileConfig(value: unknown): ReviewProfileConfig {
  if (!isRecord(value)) throw new Error('Review profile config must be an object.')
  const entries = Object.entries(value).sort(([left], [right]) => compareText(left, right))
  const result: ReviewProfileConfig = {}
  for (const [plugin, rawConfig] of entries) {
    if (!safeIdPattern.test(plugin) || !isRecord(rawConfig)) {
      throw new Error('Review profile config plugin entries must be named objects.')
    }
    const config: Record<string, PluginConfigValue> = {}
    for (const [key, rawValue] of Object.entries(rawConfig).sort(([left], [right]) => compareText(left, right))) {
      if (!safeConfigKeyPattern.test(key)) {
        throw new Error(`Review profile config for "${plugin}" has an invalid field name.`)
      }
      config[key] = assertConfigValueShape(rawValue, `${plugin}.${key}`)
    }
    if (Object.keys(config).length > 0) result[plugin] = canonicalizePluginConfigValues(config)
  }
  return result
}

export function parseReviewProfile(value: unknown): ReviewProfile {
  if (!isRecord(value)) throw new Error('Review source binding profile must be an object.')
  const keys = Object.keys(value).sort(compareText)
  if (keys.join(',') !== 'config,id,inputDigest,kind,platform,scope') {
    throw new Error('Review source binding profile fields are invalid.')
  }
  const platform = value.platform
  const scope = value.scope
  if (
    value.kind !== 'review'
    || (platform !== 'codex' && platform !== 'claude' && platform !== 'agent-skills')
    || (scope !== 'user' && scope !== 'project')
    || value.id !== `${platform}-${scope}`
    || typeof value.inputDigest !== 'string'
    || !digestPattern.test(value.inputDigest)
  ) throw new Error('Review source binding profile identity is invalid.')
  return {
    kind: 'review',
    id: `${platform}-${scope}`,
    platform,
    scope,
    inputDigest: value.inputDigest,
    config: normalizeReviewProfileConfig(value.config),
  }
}

export function resolveReviewPluginProfileConfig(options: {
  plugin: PluginMeta
  scope: Scope
  config: ReviewProfileConfig
  keys?: readonly string[]
}): ReviewPluginProfileConfig {
  const fields = options.plugin.manifest.config?.fields ?? {}
  const supplied = options.config[options.plugin.manifest.name] ?? {}
  const selectedKeys = new Set(options.keys ?? Object.keys(fields))
  const normalizedOverrides: Record<string, PluginConfigValue> = {}

  for (const [key, value] of Object.entries(supplied)) {
    const field = fields[key]
    if (!field) {
      throw new ReviewSelectionError(
        'invalidConfig',
        `Plugin "${options.plugin.manifest.name}" does not declare config field "${key}".`,
      )
    }
    if (field.sensitive === true) {
      throw new ReviewSelectionError(
        'invalidConfig',
        `Review config cannot provide sensitive field "${options.plugin.manifest.name}.${key}".`,
      )
    }
    const issues = validatePluginConfigValue(field, value, key)
    if (issues.length > 0) {
      throw new ReviewSelectionError(
        'invalidConfig',
        `Plugin "${options.plugin.manifest.name}" config is invalid: ${formatPluginConfigIssue(issues[0]!)}`,
      )
    }
    if (!selectedKeys.has(key)) continue
    if (field.default === undefined || !sameConfigValue(field.default, value)) {
      normalizedOverrides[key] = value
    }
  }

  const values: Record<string, PluginConfigValue> = {}
  const sources: Record<string, PluginConfigSource> = {}
  for (const [key, field] of Object.entries(fields)) {
    if (!selectedKeys.has(key)) continue
    if (field.default !== undefined) {
      values[key] = field.default
      sources[key] = 'default'
    }
  }
  for (const [key, value] of Object.entries(normalizedOverrides)) {
    values[key] = value
    sources[key] = options.scope
  }

  const selectedFields = Object.fromEntries(Object.entries(fields)
    .filter(([key]) => selectedKeys.has(key)))
  const issues = validatePluginConfigDocument({ schemaVersion: 3, fields: selectedFields }, values)
  const missing = issues.find((issue) => issue.code === 'required')
  if (missing) {
    throw new ReviewSelectionError(
      'requiredConfigMissing',
      `Plugin "${options.plugin.manifest.name}" requires config field "${missing.path.field}".`,
      3,
    )
  }
  if (issues.length > 0) {
    throw new ReviewSelectionError(
      'invalidConfig',
      `Plugin "${options.plugin.manifest.name}" config is invalid: ${formatPluginConfigIssue(issues[0]!)}`,
    )
  }

  const canonicalOverrides = canonicalizePluginConfigValues(normalizedOverrides)
  const canonicalValues = canonicalizePluginConfigValues(values)
  const canonicalSources = Object.fromEntries(
    Object.entries(sources).sort(([left], [right]) => compareText(left, right)),
  )
  return {
    plugin: options.plugin,
    pluginName: options.plugin.manifest.name,
    scope: options.scope,
    overrides: canonicalOverrides,
    values: canonicalValues,
    sources: canonicalSources,
    digest: digestCanonical({ values: canonicalValues, sources: canonicalSources }),
  }
}

export function createReviewProfile(options: {
  platform: ReviewPlatform
  scope: Scope
  config: ReviewProfileConfig
  skills: readonly ReviewSelectedSkill[]
  pluginConfigs: readonly ReviewPluginProfileConfig[]
}): ReviewProfile {
  const config = normalizeReviewProfileConfig(Object.fromEntries(Object.entries(options.config)
    .filter(([, values]) => Object.keys(values).length > 0)))
  const skillInputs = options.skills.map((skill) => ({
    plugin: skill.pluginName,
    skill: skill.name,
    targetId: skill.targetId,
    delivery: skill.delivery,
    configScope: skill.configScope,
    configScopes: skill.configScopes,
    refreshKeys: [...skill.refreshKeys].sort(compareText),
  })).sort((left, right) => compareText(
    `${left.plugin}\0${left.skill}\0${left.targetId ?? ''}`,
    `${right.plugin}\0${right.skill}\0${right.targetId ?? ''}`,
  ))
  const configInputs = options.pluginConfigs.map((entry) => ({
    plugin: entry.pluginName,
    scope: entry.scope,
    values: entry.values,
    sources: entry.sources,
  })).sort((left, right) => compareText(
    `${left.plugin}\0${left.scope}`,
    `${right.plugin}\0${right.scope}`,
  ))
  return {
    kind: 'review',
    id: `${options.platform}-${options.scope}`,
    platform: options.platform,
    scope: options.scope,
    inputDigest: digestCanonical({
      platform: options.platform,
      scope: options.scope,
      skills: skillInputs,
      config: configInputs,
    }),
    config,
  }
}
