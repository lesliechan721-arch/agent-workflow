import { RE2 } from 're2-wasm'

import type {
  PluginConfigAdditionalPropertiesField,
  PluginConfigArray,
  PluginConfigArrayField,
  PluginConfigArrayItemField,
  PluginConfigArrayValidation,
  PluginConfigChoices,
  PluginConfigDefinition,
  PluginConfigJoinSummary,
  PluginConfigNumberValidation,
  PluginConfigObject,
  PluginConfigObjectField,
  PluginConfigObjectPropertyField,
  PluginConfigPresentation,
  PluginConfigPreset,
  PluginConfigScalar,
  PluginConfigScalarField,
  PluginConfigSchemaField,
  PluginConfigStringFormat,
  PluginConfigStringValidation,
  PluginConfigValidationIssue,
  PluginConfigValue,
  PluginConfigValueReference,
} from './types.js'

const CONFIG_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/u
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/u
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:0|[1-9]\d*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/u
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const STRING_FORMATS = new Set<PluginConfigStringFormat>([
  'identifier',
  'slug',
  'semver',
  'url',
  'hostname',
  'email',
])
export const PLUGIN_CONFIG_V3_MAX_DEFINITIONS = 64
export const PLUGIN_CONFIG_V3_MAX_FIELDS = 256
/** Count each followed $ref edge, including edges from object properties; inline objects add zero. */
export const PLUGIN_CONFIG_V3_MAX_REF_DEPTH = 8
export const PLUGIN_CONFIG_SUMMARY_MAX_PARTS = 4
export const PLUGIN_CONFIG_SUMMARY_MAX_SEPARATOR_CODE_POINTS = 8
export const PLUGIN_CONFIG_SUMMARY_MAX_PATH_LENGTH = 128
export const PLUGIN_CONFIG_SUMMARY_MAX_CODE_POINTS = 256
export const PLUGIN_CONFIG_ARRAY_MAX_ITEMS = 128
export const PLUGIN_CONFIG_ARRAY_MAX_BYTES = 262144
const MAX_OBJECT_PROPERTIES = 32
const MAX_PATTERN_CODE_POINTS = 512
const MAX_STRING_CODE_POINTS = 4096
const DANGEROUS_CONFIG_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function createPropertyMap<Value>(): Record<string, Value> {
  return Object.create(null) as Record<string, Value>
}

function ownProperty<Value>(
  value: Record<string, Value> | undefined,
  property: string,
): Value | undefined {
  return value !== undefined && Object.hasOwn(value, property) ? value[property] : undefined
}

function isDangerousConfigKey(value: string): boolean {
  return DANGEROUS_CONFIG_KEYS.has(value)
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${path}: expected an object.`)
  }
  return value as Record<string, unknown>
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`Invalid ${path}: unknown field "${key}".`)
    }
  }
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${path}: expected a non-empty string.`)
  }
  return value
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : nonEmptyString(value, path)
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid ${path}: expected a boolean.`)
  }
  return value
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${path}: expected a finite number.`)
  }
  return value
}

function nonNegativeInteger(value: unknown, path: string): number {
  const result = finiteNumber(value, path)
  if (!Number.isInteger(result) || result < 0) {
    throw new Error(`Invalid ${path}: expected a non-negative integer.`)
  }
  return result
}

function normalizeStringValidation(
  value: unknown,
  path: string,
): PluginConfigStringValidation {
  const input = asObject(value, path)
  assertAllowedKeys(input, path, ['minLength', 'maxLength', 'pattern', 'format'])
  const minLength = input.minLength === undefined
    ? undefined
    : nonNegativeInteger(input.minLength, `${path}.minLength`)
  const maxLength = input.maxLength === undefined
    ? undefined
    : nonNegativeInteger(input.maxLength, `${path}.maxLength`)
  if (maxLength !== undefined && maxLength > MAX_STRING_CODE_POINTS) {
    throw new Error(`Invalid ${path}.maxLength: expected at most ${MAX_STRING_CODE_POINTS}.`)
  }
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    throw new Error(`Invalid ${path}: minLength must be less than or equal to maxLength.`)
  }
  if (input.pattern !== undefined && typeof input.pattern !== 'string') {
    throw new Error(`Invalid ${path}.pattern: expected a string.`)
  }
  const pattern = input.pattern as string | undefined
  if (pattern !== undefined) {
    if ([...pattern].length > MAX_PATTERN_CODE_POINTS) {
      throw new Error(`Invalid ${path}.pattern: expected at most ${MAX_PATTERN_CODE_POINTS} Unicode code points.`)
    }
    if (maxLength === undefined) {
      throw new Error(`Invalid ${path}: maxLength is required when pattern is declared.`)
    }
    try {
      new RE2(pattern, 'u')
    } catch {
      throw new Error(`Invalid ${path}.pattern: expected a valid RE2 regular expression.`)
    }
  }
  const format = input.format === undefined
    ? undefined
    : nonEmptyString(input.format, `${path}.format`) as PluginConfigStringFormat
  if (format !== undefined && !STRING_FORMATS.has(format)) {
    throw new Error(`Invalid ${path}.format: unsupported string format "${format}".`)
  }
  return { minLength, maxLength, pattern, format }
}

function normalizeNumberValidation(
  value: unknown,
  path: string,
): PluginConfigNumberValidation {
  const input = asObject(value, path)
  assertAllowedKeys(input, path, ['integer', 'minimum', 'maximum', 'multipleOf'])
  const integer = optionalBoolean(input.integer, `${path}.integer`)
  const minimum = input.minimum === undefined
    ? undefined
    : finiteNumber(input.minimum, `${path}.minimum`)
  const maximum = input.maximum === undefined
    ? undefined
    : finiteNumber(input.maximum, `${path}.maximum`)
  const multipleOf = input.multipleOf === undefined
    ? undefined
    : finiteNumber(input.multipleOf, `${path}.multipleOf`)
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new Error(`Invalid ${path}: minimum must be less than or equal to maximum.`)
  }
  if (multipleOf !== undefined && multipleOf <= 0) {
    throw new Error(`Invalid ${path}.multipleOf: expected a number greater than zero.`)
  }
  return { integer, minimum, maximum, multipleOf }
}

function createIssue(
  code: string,
  field: string,
  message: string,
  property?: string,
): PluginConfigValidationIssue {
  return {
    code,
    path: property === undefined ? { field } : { field, property },
    message,
    recoverable: true,
  }
}

function withArrayPath(issue: PluginConfigValidationIssue, index: number): PluginConfigValidationIssue {
  return {
    ...issue,
    path: {
      ...issue.path,
      segments: [issue.path.field, index, ...(issue.path.property === undefined ? [] : [issue.path.property])],
    },
  }
}

function isSafeJsonRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(value).every((key) =>
    typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))
}

function isDenseDataArray(value: unknown[]): boolean {
  if (Object.getPrototypeOf(value) !== Array.prototype) return false
  if (Reflect.ownKeys(value).length !== value.length + 1) return false
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(index)) ?? {}, 'value')) return false
  }
  return true
}

function stringFormatMatches(value: string, format: PluginConfigStringFormat): boolean {
  if (format === 'identifier') return IDENTIFIER_PATTERN.test(value)
  if (format === 'slug') return SLUG_PATTERN.test(value)
  if (format === 'semver') return SEMVER_PATTERN.test(value)
  if (format === 'hostname') return HOSTNAME_PATTERN.test(value)
  if (format === 'email') return EMAIL_PATTERN.test(value)
  try {
    const url = new URL(value)
    return url.protocol.length > 1
  } catch {
    return false
  }
}

function validateString(
  value: unknown,
  validation: PluginConfigStringValidation | undefined,
  field: string,
  property?: string,
): PluginConfigValidationIssue[] {
  if (typeof value !== 'string') {
    return [createIssue('type', field, 'Expected a string.', property)]
  }
  const issues: PluginConfigValidationIssue[] = []
  if (validation?.minLength !== undefined && [...value].length < validation.minLength) {
    issues.push(createIssue('minLength', field, `Expected at least ${validation.minLength} characters.`, property))
  }
  if (validation?.maxLength !== undefined && [...value].length > validation.maxLength) {
    issues.push(createIssue('maxLength', field, `Expected at most ${validation.maxLength} characters.`, property))
  }
  if (validation?.pattern !== undefined && !new RE2(validation.pattern, 'u').test(value)) {
    issues.push(createIssue('pattern', field, `Expected a value that matches ${validation.pattern}.`, property))
  }
  if (validation?.format !== undefined && !stringFormatMatches(value, validation.format)) {
    issues.push(createIssue('format', field, `Expected ${validation.format} format.`, property))
  }
  return issues
}

function validateNumber(
  value: unknown,
  validation: PluginConfigNumberValidation | undefined,
  field: string,
  property?: string,
): PluginConfigValidationIssue[] {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return [createIssue('type', field, 'Expected a finite number.', property)]
  }
  const issues: PluginConfigValidationIssue[] = []
  if (validation?.integer === true && !Number.isInteger(value)) {
    issues.push(createIssue('integer', field, 'Expected an integer.', property))
  }
  if (validation?.minimum !== undefined && value < validation.minimum) {
    issues.push(createIssue('minimum', field, `Expected a number greater than or equal to ${validation.minimum}.`, property))
  }
  if (validation?.maximum !== undefined && value > validation.maximum) {
    issues.push(createIssue('maximum', field, `Expected a number less than or equal to ${validation.maximum}.`, property))
  }
  if (
    validation?.multipleOf !== undefined
    && Math.abs(value / validation.multipleOf - Math.round(value / validation.multipleOf)) > 1e-9
  ) {
    issues.push(createIssue('multipleOf', field, `Expected a multiple of ${validation.multipleOf}.`, property))
  }
  return issues
}

function validateScalarField(
  fieldDefinition: PluginConfigScalarField | PluginConfigObjectPropertyField | PluginConfigAdditionalPropertiesField,
  value: unknown,
  field: string,
  property?: string,
  checkChoices = true,
): PluginConfigValidationIssue[] {
  const issues = fieldDefinition.type === 'string'
    ? validateString(value, fieldDefinition.validation, field, property)
    : fieldDefinition.type === 'number'
      ? validateNumber(value, fieldDefinition.validation, field, property)
      : typeof value === 'boolean'
        ? []
        : [createIssue('type', field, 'Expected a boolean.', property)]
  if (
    checkChoices
    && issues.length === 0
    && fieldDefinition.choices?.allowCustom === false
    && matchPluginConfigPreset(fieldDefinition as PluginConfigSchemaField, value as PluginConfigValue) === undefined
  ) {
    issues.push(createIssue('choice', field, 'Expected a declared preset value.', property))
  }
  return issues
}

function validateObjectField(
  fieldDefinition: PluginConfigObjectField,
  value: unknown,
  field: string,
  checkChoices = true,
): PluginConfigValidationIssue[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [createIssue('type', field, 'Expected an object.')]
  }
  const input = value as Record<string, unknown>
  const keys = Object.keys(input)
  const issues: PluginConfigValidationIssue[] = []
  if (keys.length > MAX_OBJECT_PROPERTIES) {
    issues.push(createIssue('maxProperties', field, `Expected at most ${MAX_OBJECT_PROPERTIES} properties.`))
  }
  if (
    fieldDefinition.validation?.minProperties !== undefined
    && keys.length < fieldDefinition.validation.minProperties
  ) {
    issues.push(createIssue('minProperties', field, `Expected at least ${fieldDefinition.validation.minProperties} properties.`))
  }
  if (
    fieldDefinition.validation?.maxProperties !== undefined
    && keys.length > fieldDefinition.validation.maxProperties
  ) {
    issues.push(createIssue('maxProperties', field, `Expected at most ${fieldDefinition.validation.maxProperties} properties.`))
  }
  for (const [property, child] of Object.entries(fieldDefinition.properties ?? {})) {
    if (child.required === true && !Object.hasOwn(input, property)) {
      issues.push(createIssue('required', field, 'Required property is missing.', property))
    }
  }
  for (const [property, childValue] of Object.entries(input)) {
    if (isDangerousConfigKey(property)) {
      issues.push(createIssue('dangerousKey', field, 'Dangerous config key is not allowed.', property))
      continue
    }
    const child = ownProperty(fieldDefinition.properties, property)
    if (child !== undefined) {
      issues.push(...validateScalarField(child, childValue, field, property))
      continue
    }
    const dynamicChild = fieldDefinition.additionalProperties
    if (dynamicChild === undefined || dynamicChild === false) {
      issues.push(createIssue('additionalProperty', field, 'Additional property is not allowed.', property))
      continue
    }
    if (fieldDefinition.validation?.key !== undefined) {
      issues.push(...validateString(property, fieldDefinition.validation.key, field, property))
    }
    issues.push(...validateScalarField(dynamicChild, childValue, field, property))
  }
  if (
    checkChoices
    && issues.length === 0
    && fieldDefinition.choices?.allowCustom === false
    && matchPluginConfigPreset(fieldDefinition, input as PluginConfigObject) === undefined
  ) {
    issues.push(createIssue('choice', field, 'Expected a declared preset value.'))
  }
  return issues
}

function validateArrayField(
  fieldDefinition: PluginConfigArrayField,
  value: unknown,
  field: string,
  checkChoices = true,
): PluginConfigValidationIssue[] {
  if (!Array.isArray(value)) {
    return [{ ...createIssue('type', field, 'Expected a dense array of JSON values.'), path: { field, segments: [field] } }]
  }
  if (value.length > PLUGIN_CONFIG_ARRAY_MAX_ITEMS) {
    return [{ ...createIssue('maxItems', field, `Expected at most ${PLUGIN_CONFIG_ARRAY_MAX_ITEMS} items.`),
      path: { field, segments: [field] } }]
  }
  if (!isDenseDataArray(value)) {
    return [{ ...createIssue('type', field, 'Expected a dense array of JSON values.'), path: { field, segments: [field] } }]
  }
  const issues: PluginConfigValidationIssue[] = []
  const count = value.length
  const min = fieldDefinition.validation?.minItems
  const max = fieldDefinition.validation?.maxItems ?? PLUGIN_CONFIG_ARRAY_MAX_ITEMS
  if (count < (min ?? 0)) issues.push(createIssue('minItems', field, `Expected at least ${min} items.`))
  if (count > max) issues.push(createIssue('maxItems', field, `Expected at most ${max} items.`))
  const seen = new Set<string>()
  const seenProperties = new Set<PluginConfigScalar>()
  for (const [index, item] of value.entries()) {
    const itemIssues = fieldDefinition.items.type === 'object'
      ? isSafeJsonRecord(item)
        ? validateObjectField(fieldDefinition.items as PluginConfigObjectField, item, field)
        : [createIssue('type', field, 'Expected a JSON object.')]
      : validateScalarField(fieldDefinition.items, item, field)
    issues.push(...itemIssues.map((issue) => withArrayPath(issue, index)))
    const uniqueBy = fieldDefinition.validation?.uniqueBy
    if (uniqueBy !== undefined && itemIssues.length === 0 && isSafeJsonRecord(item)) {
      if (!Object.hasOwn(item, uniqueBy)) {
        issues.push(withArrayPath(createIssue('uniqueBy', field, 'Unique property is missing.', uniqueBy), index))
      } else {
        const key = item[uniqueBy] as PluginConfigScalar
        if (seenProperties.has(key)) {
          issues.push(withArrayPath(createIssue('uniqueBy', field, 'Expected a unique property value.', uniqueBy), index))
        }
        seenProperties.add(key)
      }
    }
    if (fieldDefinition.validation?.uniqueItems === true && itemIssues.length === 0) {
      const key = stablePluginConfigStringify(item as PluginConfigValue)
      if (seen.has(key)) {
        issues.push(withArrayPath(createIssue('uniqueItems', field, 'Expected unique items.'), index))
      }
      seen.add(key)
    }
  }
  if (issues.length === 0) {
    const bytes = Buffer.byteLength(stablePluginConfigStringify(value as PluginConfigArray), 'utf8')
    if (bytes > PLUGIN_CONFIG_ARRAY_MAX_BYTES) {
      issues.push(createIssue('maxBytes', field, `Expected at most ${PLUGIN_CONFIG_ARRAY_MAX_BYTES} UTF-8 JSON bytes.`))
    }
  }
  if (checkChoices && issues.length === 0 && fieldDefinition.choices?.allowCustom === false
    && matchPluginConfigPreset(fieldDefinition, value as PluginConfigArray) === undefined) {
    issues.push(createIssue('choice', field, 'Expected a declared preset value.'))
  }
  return issues.map((issue) => issue.path.segments === undefined
    ? { ...issue, path: { ...issue.path, segments: [field] } }
    : issue)
}

function resolveValueArguments(
  first: PluginConfigSchemaField | string,
  second: unknown,
  third: unknown,
): { definition: PluginConfigSchemaField; value: unknown; field: string } {
  if (typeof first === 'string') {
    return {
      field: first,
      definition: second as PluginConfigSchemaField,
      value: third,
    }
  }
  return {
    definition: first,
    value: second,
    field: typeof third === 'string' ? third : 'value',
  }
}

export function validatePluginConfigValue(
  definition: PluginConfigSchemaField,
  value: unknown,
  field?: string,
): PluginConfigValidationIssue[]
export function validatePluginConfigValue(
  field: string,
  definition: PluginConfigSchemaField,
  value: unknown,
): PluginConfigValidationIssue[]
export function validatePluginConfigValue(
  first: PluginConfigSchemaField | string,
  second: unknown,
  third?: unknown,
): PluginConfigValidationIssue[] {
  const resolved = resolveValueArguments(first, second, third)
  return resolved.definition.type === 'object'
    ? validateObjectField(resolved.definition, resolved.value, resolved.field)
    : resolved.definition.type === 'array'
      ? validateArrayField(resolved.definition, resolved.value, resolved.field)
      : validateScalarField(resolved.definition, resolved.value, resolved.field)
}

export function validatePluginConfigDocument(
  definition: PluginConfigDefinition,
  value: unknown,
): PluginConfigValidationIssue[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [createIssue('type', '$document', 'Expected a config object.')]
  }
  const input = value as Record<string, unknown>
  const issues: PluginConfigValidationIssue[] = []
  for (const [field, fieldDefinition] of Object.entries(definition.fields)) {
    if (!Object.hasOwn(input, field)) {
      if (fieldDefinition.required === true) {
        issues.push(createIssue('required', field, 'Required field is missing.'))
      }
      continue
    }
    issues.push(...validatePluginConfigValue(fieldDefinition, input[field], field))
  }
  for (const field of Object.keys(input)) {
    if (isDangerousConfigKey(field)) {
      issues.push(createIssue('dangerousKey', field, 'Dangerous config key is not allowed.'))
      continue
    }
    if (!Object.hasOwn(definition.fields, field)) {
      issues.push(createIssue('unknownField', field, 'Unknown config field.'))
    }
  }
  return [...issues, ...validatePluginConfigReferences(definition, input, Object.keys(definition.fields))]
}

type ConfigScalarSchema = PluginConfigScalarField | PluginConfigObjectPropertyField | PluginConfigAdditionalPropertiesField

function scalarSchemas(definition: PluginConfigSchemaField): ConfigScalarSchema[] {
  if (definition.type === 'array') return scalarSchemas(definition.items as PluginConfigSchemaField)
  if (definition.type !== 'object') return [definition]
  return definition.properties === undefined
    ? [definition.additionalProperties as PluginConfigAdditionalPropertiesField]
    : Object.values(definition.properties)
}

/** Returns validation dependencies only; callers still project their original allowed keys. */
export function getPluginConfigDependencyKeys(
  definition: PluginConfigDefinition,
  keys: readonly string[],
): string[] {
  const result = new Set<string>()
  const visit = (key: string): void => {
    if (result.has(key)) return
    const field = ownProperty(definition.fields, key)
    if (field === undefined) throw new Error(`Unknown config key "${key}".`)
    result.add(key)
    for (const scalar of scalarSchemas(field)) {
      if ('valueRef' in scalar && scalar.valueRef !== undefined) visit(scalar.valueRef.field)
    }
  }
  keys.forEach(visit)
  return [...result]
}

function validatePluginConfigReferences(
  definition: PluginConfigDefinition,
  input: Record<string, unknown>,
  keys: readonly string[],
): PluginConfigValidationIssue[] {
  const issues: PluginConfigValidationIssue[] = []
  const reservedPaths = new Set<string>()
  const sources = new Map<string, { entries: PluginConfigObject[]; valid: boolean }>()
  const allowedValues = new Map<PluginConfigValueReference, Set<PluginConfigScalar>>()
  const check = (scalar: ConfigScalarSchema, value: unknown, field: string, property?: string, index?: number): void => {
    if (!('valueRef' in scalar) || scalar.valueRef === undefined) return
    const ref = scalar.valueRef
    let source = sources.get(ref.field)
    if (source === undefined) {
      const sourceSchema = definition.fields[ref.field]!
      const sourceValue = ownProperty(input, ref.field)
      const valid = sourceValue === undefined
        ? sourceSchema.required !== true
        : validatePluginConfigValue(sourceSchema, sourceValue, ref.field).length === 0
      source = { valid, entries: valid ? (sourceValue ?? []) as PluginConfigObject[] : [] }
      sources.set(ref.field, source)
    }
    const add = (code: string, message: string): void => {
      const issue = createIssue(code, field, message, property)
      issues.push(index === undefined ? issue : withArrayPath(issue, index))
    }
    if (!source.valid) {
      add('valueRefSource', `Referenced config "${ref.field}" is invalid; fix its complete array value.`)
      return
    }
    let allowed = allowedValues.get(ref)
    if (allowed === undefined) {
      allowed = new Set(ref.include)
      for (const [sourceIndex, entry] of source.entries.entries()) {
        if (ref.include?.includes(entry[ref.key]!) === true) {
          const pathKey = `${ref.field}\0${sourceIndex}\0${ref.key}`
          if (!reservedPaths.has(pathKey)) {
            reservedPaths.add(pathKey)
            issues.push(withArrayPath(createIssue('valueRefReserved', ref.field,
              'Referenced property collides with a reserved included value.', ref.key), sourceIndex))
          }
        }
        allowed.add(entry[ref.key]!)
      }
      allowedValues.set(ref, allowed)
    }
    if (value === undefined || validateScalarField(scalar, value, field, property).length > 0) return
    if (!allowed.has(value as PluginConfigScalar)) {
      add('valueRef', `Expected an included value or a key from config "${ref.field}". Add that key first, update dependent fields, then remove the old key.`)
    }
  }
  for (const field of keys) {
    const schema = definition.fields[field]!
    const value = ownProperty(input, field)
    if (schema.type === 'array') {
      // Validate reserved values even when no dependent value is currently set.
      for (const scalar of scalarSchemas(schema)) check(scalar, undefined, field)
      if (Array.isArray(value) && validatePluginConfigValue(schema, value, field).length === 0) {
        for (const [index, item] of value.entries()) {
          if (schema.items.type === 'object') {
            for (const [property, scalar] of Object.entries(schema.items.properties ?? {})) check(scalar, item[property], field, property, index)
            if (schema.items.properties === undefined) {
              for (const [property, child] of Object.entries(item)) check(schema.items.additionalProperties as PluginConfigAdditionalPropertiesField, child, field, property, index)
            }
          } else check(schema.items, item, field, undefined, index)
        }
      }
    } else if (schema.type === 'object') {
      if (schema.properties !== undefined) {
        for (const [property, scalar] of Object.entries(schema.properties)) {
          check(scalar, isSafeJsonRecord(value) ? ownProperty(value, property) : undefined, field, property)
        }
      } else {
        check(schema.additionalProperties, undefined, field)
        if (isSafeJsonRecord(value)) {
          for (const [property, child] of Object.entries(value)) check(schema.additionalProperties, child, field, property)
        }
      }
    } else check(schema, value, field)
  }
  return issues
}

/** Validate one effective candidate, including complete sources required by selected fields. */
export function validatePluginConfigCandidate(
  definition: PluginConfigDefinition,
  values: unknown,
  keys?: readonly string[],
): PluginConfigValidationIssue[] {
  if (!isSafeJsonRecord(values)) return [createIssue('type', '$document', 'Expected a config JSON object.')]
  if (keys === undefined) return validatePluginConfigDocument(definition, values)
  const closure = getPluginConfigDependencyKeys(definition, keys)
  const projected = Object.fromEntries(closure.flatMap((key) => Object.hasOwn(values, key) ? [[key, values[key]]] : []))
  return validatePluginConfigDocument({ ...definition, fields: Object.fromEntries(closure.map((key) => [key, definition.fields[key]!])) } as PluginConfigDefinition, projected)
}

function assertValueReferenceSchemas(
  fields: Record<string, PluginConfigSchemaField>,
  definitions: readonly PluginConfigSchemaField[],
  path: string,
  allowReferences = true,
): void {
  for (const definition of definitions) {
    for (const scalar of scalarSchemas(definition)) {
      if (!('valueRef' in scalar) || scalar.valueRef === undefined) continue
      if (!allowReferences) throw new Error(`Invalid ${path}: valueRef requires Config Definition v3.`)
      const ref = scalar.valueRef
      const source = ownProperty(fields, ref.field)
      if (source?.type !== 'array' || source.items.type !== 'object' || source.items.properties === undefined) {
        throw new Error(`Invalid ${path}.valueRef.field: expected a declared fixed-object array.`)
      }
      const key = ownProperty(source.items.properties, ref.key)
      if (key === undefined || key.type !== scalar.type || source.validation?.uniqueBy !== ref.key) {
        throw new Error(`Invalid ${path}.valueRef.key: expected a scalar of the same type with matching uniqueBy.`)
      }
      if (ref.label !== undefined && ownProperty(source.items.properties, ref.label) === undefined) {
        throw new Error(`Invalid ${path}.valueRef.label: expected a declared scalar property.`)
      }
    }
  }
}

export function canonicalizePluginConfigValue(value: PluginConfigValue): PluginConfigValue {
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => canonicalizePluginConfigValue(item)) as PluginConfigArray
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  )
}

export function canonicalizePluginConfigValues(
  values: Readonly<Record<string, PluginConfigValue>>,
): Record<string, PluginConfigValue> {
  return Object.fromEntries(Object.entries(values)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => [key, canonicalizePluginConfigValue(value)]))
}

export function stablePluginConfigStringify(value: PluginConfigValue): string {
  return JSON.stringify(canonicalizePluginConfigValue(value))
}

export function matchPluginConfigPreset(
  definition: PluginConfigSchemaField,
  value: PluginConfigValue,
): PluginConfigPreset | undefined {
  return definition.choices?.presets.find((preset) =>
    stablePluginConfigStringify(preset.value) === stablePluginConfigStringify(value))
}

export function validatePluginConfigPreset(
  definition: PluginConfigSchemaField,
  preset: PluginConfigPreset,
  field = 'value',
): PluginConfigValidationIssue[] {
  return definition.type === 'object'
    ? validateObjectField(definition, preset.value, field, false)
    : definition.type === 'array'
      ? validateArrayField(definition, preset.value, field, false)
      : validateScalarField(definition, preset.value, field, undefined, false)
}

export type RedactedPluginConfigValue = PluginConfigValue | '[redacted]' | Record<string, PluginConfigScalar | '[redacted]'>

export function redactPluginConfigValue(
  definition: PluginConfigSchemaField,
  value: PluginConfigValue,
): RedactedPluginConfigValue {
  if (definition.type === 'string' && definition.sensitive === true) return '[redacted]'
  return value
}

export function formatPluginConfigIssue(issue: PluginConfigValidationIssue): string {
  const path = issue.path.segments !== undefined
    ? issue.path.segments.map((segment, index) => typeof segment === 'number' ? `[${segment}]` : index === 0 ? segment : `.${segment}`).join('')
    : issue.path.property === undefined
    ? issue.path.field
    : `${issue.path.field}.${issue.path.property}`
  return `${path}: ${issue.message}`
}

function normalizePreset<Value extends PluginConfigValue>(
  value: unknown,
  path: string,
): PluginConfigPreset<Value> {
  const input = asObject(value, path)
  assertAllowedKeys(input, path, ['id', 'title', 'description', 'value', 'recommended'])
  if (!Object.hasOwn(input, 'value')) {
    throw new Error(`Invalid ${path}.value: value is required.`)
  }
  if (input.recommended !== undefined && input.recommended !== true) {
    throw new Error(`Invalid ${path}.recommended: expected true.`)
  }
  return {
    id: nonEmptyString(input.id, `${path}.id`),
    title: nonEmptyString(input.title, `${path}.title`),
    description: optionalText(input.description, `${path}.description`),
    value: input.value as Value,
    recommended: input.recommended as true | undefined,
  }
}

function normalizeChoices<Value extends PluginConfigValue>(
  value: unknown,
  path: string,
): PluginConfigChoices<Value> {
  const input = asObject(value, path)
  assertAllowedKeys(input, path, ['allowCustom', 'presets'])
  if (typeof input.allowCustom !== 'boolean') {
    throw new Error(`Invalid ${path}.allowCustom: expected a boolean.`)
  }
  if (!Array.isArray(input.presets)) {
    throw new Error(`Invalid ${path}.presets: expected an array.`)
  }
  return {
    allowCustom: input.allowCustom,
    presets: input.presets.map((preset, index) =>
      normalizePreset<Value>(preset, `${path}.presets[${index}]`)),
  }
}

function normalizeScalarField(
  value: unknown,
  path: string,
  options: { allowDefault: boolean; allowRequired: boolean; allowSensitive: boolean },
): PluginConfigScalarField | PluginConfigObjectPropertyField | PluginConfigAdditionalPropertiesField {
  const input = asObject(value, path)
  const type = nonEmptyString(input.type, `${path}.type`)
  if (type !== 'string' && type !== 'number' && type !== 'boolean') {
    throw new Error(`Invalid ${path}.type: expected string, number, or boolean.`)
  }
  const allowed = ['type', 'title', 'description']
  if (options.allowDefault) allowed.push('default')
  if (options.allowRequired) allowed.push('required')
  if (options.allowSensitive && type === 'string') allowed.push('sensitive')
  allowed.push('choices', 'valueRef')
  if (type !== 'boolean') allowed.push('validation')
  assertAllowedKeys(input, path, allowed)
  const sensitive = options.allowSensitive && type === 'string'
    ? optionalBoolean(input.sensitive, `${path}.sensitive`)
    : undefined
  if (sensitive === true && input.default !== undefined) {
    throw new Error(`Invalid ${path}.default: sensitive fields cannot declare a default.`)
  }
  if (sensitive === true && input.choices !== undefined) {
    throw new Error(`Invalid ${path}.choices: sensitive fields cannot declare choices.`)
  }
  if (sensitive === true && input.valueRef !== undefined) {
    throw new Error(`Invalid ${path}.valueRef: sensitive fields cannot declare value references.`)
  }
  let valueRef: PluginConfigValueReference | undefined
  if (input.valueRef !== undefined) {
    const rawRef = asObject(input.valueRef, `${path}.valueRef`)
    assertAllowedKeys(rawRef, `${path}.valueRef`, ['field', 'key', 'label', 'include'])
    let include: PluginConfigScalar[] | undefined
    if (rawRef.include !== undefined) {
      if (!Array.isArray(rawRef.include) || !isDenseDataArray(rawRef.include)
        || rawRef.include.length > PLUGIN_CONFIG_ARRAY_MAX_ITEMS) {
        throw new Error(`Invalid ${path}.valueRef.include: expected at most ${PLUGIN_CONFIG_ARRAY_MAX_ITEMS} scalar values.`)
      }
      include = rawRef.include.map((entry) => {
        if (typeof entry !== type || (type === 'number' && !Number.isFinite(entry))) {
          throw new Error(`Invalid ${path}.valueRef.include: expected values of type ${type}.`)
        }
        return entry as PluginConfigScalar
      })
      if (new Set(include).size !== include.length) {
        throw new Error(`Invalid ${path}.valueRef.include: expected unique scalar values.`)
      }
      if (Buffer.byteLength(JSON.stringify(include), 'utf8') > PLUGIN_CONFIG_ARRAY_MAX_BYTES) {
        throw new Error(`Invalid ${path}.valueRef.include: expected at most ${PLUGIN_CONFIG_ARRAY_MAX_BYTES} UTF-8 JSON bytes.`)
      }
    }
    valueRef = {
      field: nonEmptyString(rawRef.field, `${path}.valueRef.field`),
      key: nonEmptyString(rawRef.key, `${path}.valueRef.key`),
      label: optionalText(rawRef.label, `${path}.valueRef.label`),
      include,
    }
  }
  const common = {
    title: optionalText(input.title, `${path}.title`),
    description: optionalText(input.description, `${path}.description`),
    ...(options.allowRequired ? { required: optionalBoolean(input.required, `${path}.required`) } : {}),
    ...(valueRef === undefined ? {} : { valueRef }),
  }
  const defaultValue = options.allowDefault && input.default !== undefined
    ? input.default
    : undefined
  if (type === 'string') {
    if (sensitive === true) {
      return {
        type,
        ...common,
        sensitive: true,
        validation: input.validation === undefined
          ? undefined
          : normalizeStringValidation(input.validation, `${path}.validation`),
      }
    }
    return {
      type,
      ...common,
      ...(options.allowSensitive ? { sensitive } : {}),
      ...(options.allowDefault ? { default: defaultValue as string | undefined } : {}),
      choices: input.choices === undefined
        ? undefined
        : normalizeChoices<string>(input.choices, `${path}.choices`),
      validation: input.validation === undefined
        ? undefined
        : normalizeStringValidation(input.validation, `${path}.validation`),
    }
  }
  if (type === 'number') {
    return {
      type,
      ...common,
      ...(options.allowDefault ? { default: defaultValue as number | undefined } : {}),
      choices: input.choices === undefined
        ? undefined
        : normalizeChoices<number>(input.choices, `${path}.choices`),
      validation: input.validation === undefined
        ? undefined
        : normalizeNumberValidation(input.validation, `${path}.validation`),
    }
  }
  return {
    type,
    ...common,
    ...(options.allowDefault ? { default: defaultValue as boolean | undefined } : {}),
    choices: input.choices === undefined
      ? undefined
      : normalizeChoices<boolean>(input.choices, `${path}.choices`),
  }
}

function assertChoices(
  definition: PluginConfigSchemaField,
  path: string,
): void {
  if (definition.choices === undefined) return
  if (definition.choices.allowCustom === false && definition.choices.presets.length === 0) {
    throw new Error(`Invalid ${path}.choices.presets: expected at least one preset when allowCustom is false.`)
  }
  const ids = new Set<string>()
  const values = new Set<string>()
  let recommendedCount = 0
  for (const [index, preset] of definition.choices.presets.entries()) {
    if (ids.has(preset.id)) {
      throw new Error(`Invalid ${path}.choices.presets[${index}].id: duplicate preset id "${preset.id}".`)
    }
    ids.add(preset.id)
    const canonicalValue = stablePluginConfigStringify(preset.value)
    if (values.has(canonicalValue)) {
      throw new Error(`Invalid ${path}.choices.presets[${index}].value: duplicate preset value.`)
    }
    values.add(canonicalValue)
    if (preset.recommended === true) recommendedCount += 1
    const issues = validatePluginConfigPreset(definition, preset, path)
    if (issues.length > 0) {
      throw new Error(`Invalid ${path}.choices.presets[${index}].value: ${formatPluginConfigIssue(issues[0]!)}`)
    }
  }
  if (recommendedCount > 1) {
    throw new Error(`Invalid ${path}.choices: expected at most one recommended preset.`)
  }
}

function normalizeObjectField(value: unknown, path: string): PluginConfigObjectField {
  const input = asObject(value, path)
  assertAllowedKeys(input, path, [
    'type',
    'title',
    'description',
    'default',
    'required',
    'choices',
    'properties',
    'additionalProperties',
    'validation',
  ])
  if (input.properties === undefined && (input.additionalProperties === undefined || input.additionalProperties === false)) {
    throw new Error(`Invalid ${path}: key-value object config requires a scalar additionalProperties field.`)
  }
  if (input.properties !== undefined && input.additionalProperties !== undefined && input.additionalProperties !== false) {
    throw new Error(`Invalid ${path}: fixed and key-value object config modes cannot be mixed.`)
  }
  let properties: Record<string, PluginConfigObjectPropertyField> | undefined
  if (input.properties !== undefined) {
    const propertiesInput = asObject(input.properties, `${path}.properties`)
    if (Object.keys(propertiesInput).length > MAX_OBJECT_PROPERTIES) {
      throw new Error(`Invalid ${path}.properties: expected at most ${MAX_OBJECT_PROPERTIES} properties.`)
    }
    properties = createPropertyMap<PluginConfigObjectPropertyField>()
    for (const [property, child] of Object.entries(propertiesInput)) {
      if (isDangerousConfigKey(property)) {
        throw new Error(`Invalid ${path}.properties: dangerous config key "${property}" is not allowed.`)
      }
      properties[property] = normalizeScalarField(child, `${path}.properties.${property}`, {
        allowDefault: false,
        allowRequired: true,
        allowSensitive: false,
      }) as PluginConfigObjectPropertyField
      assertChoices(properties[property] as PluginConfigSchemaField, `${path}.properties.${property}`)
    }
  }
  let additionalProperties: PluginConfigObjectField['additionalProperties']
  if (input.additionalProperties === undefined || input.additionalProperties === false) {
    additionalProperties = false
  } else {
    additionalProperties = normalizeScalarField(
      input.additionalProperties,
      `${path}.additionalProperties`,
      { allowDefault: false, allowRequired: false, allowSensitive: false },
    ) as PluginConfigAdditionalPropertiesField
    assertChoices(additionalProperties as PluginConfigSchemaField, `${path}.additionalProperties`)
  }
  let validation: PluginConfigObjectField['validation']
  if (input.validation !== undefined) {
    const validationInput = asObject(input.validation, `${path}.validation`)
    assertAllowedKeys(validationInput, `${path}.validation`, ['minProperties', 'maxProperties', 'key'])
    const minProperties = validationInput.minProperties === undefined
      ? undefined
      : nonNegativeInteger(validationInput.minProperties, `${path}.validation.minProperties`)
    const maxProperties = validationInput.maxProperties === undefined
      ? undefined
      : nonNegativeInteger(validationInput.maxProperties, `${path}.validation.maxProperties`)
    if (minProperties !== undefined && minProperties > MAX_OBJECT_PROPERTIES) {
      throw new Error(`Invalid ${path}.validation.minProperties: expected at most ${MAX_OBJECT_PROPERTIES}.`)
    }
    if (maxProperties !== undefined && maxProperties > MAX_OBJECT_PROPERTIES) {
      throw new Error(`Invalid ${path}.validation.maxProperties: expected at most ${MAX_OBJECT_PROPERTIES}.`)
    }
    if (minProperties !== undefined && maxProperties !== undefined && minProperties > maxProperties) {
      throw new Error(`Invalid ${path}.validation: minProperties must be less than or equal to maxProperties.`)
    }
    validation = {
      minProperties,
      maxProperties,
      key: validationInput.key === undefined
        ? undefined
        : normalizeStringValidation(validationInput.key, `${path}.validation.key`),
    }
  }
  return {
    type: 'object',
    title: optionalText(input.title, `${path}.title`),
    description: optionalText(input.description, `${path}.description`),
    default: input.default as PluginConfigObject | undefined,
    required: optionalBoolean(input.required, `${path}.required`),
    choices: input.choices === undefined
      ? undefined
      : normalizeChoices<PluginConfigObject>(input.choices, `${path}.choices`),
    ...(properties === undefined
      ? { additionalProperties: additionalProperties as PluginConfigAdditionalPropertiesField }
      : { properties, additionalProperties: false as const }),
    validation,
  }
}

function normalizeArrayField(value: unknown, path: string): PluginConfigArrayField {
  const input = asObject(value, path)
  assertAllowedKeys(input, path, ['type', 'title', 'description', 'default', 'required', 'items', 'choices', 'validation'])
  const itemPath = `${path}.items`
  const item = asObject(input.items, itemPath)
  for (const forbidden of ['default', 'required', 'sensitive']) {
    if (Object.hasOwn(item, forbidden)) {
      throw new Error(`Invalid ${itemPath}.${forbidden}: array items cannot declare ${forbidden}.`)
    }
  }
  let items: PluginConfigArrayItemField
  if (item.type === 'object') {
    const { default: _default, required: _required, ...objectItem } = normalizeObjectField(item, itemPath)
    items = objectItem as PluginConfigArrayItemField
  } else {
    items = normalizeScalarField(item, itemPath, {
      allowDefault: false, allowRequired: false, allowSensitive: false,
    }) as PluginConfigArrayItemField
  }
  assertChoices(items as PluginConfigSchemaField, itemPath)
  let validation: PluginConfigArrayValidation | undefined
  if (input.validation !== undefined) {
    const rawValidation = asObject(input.validation, `${path}.validation`)
    assertAllowedKeys(rawValidation, `${path}.validation`, ['minItems', 'maxItems', 'uniqueItems', 'uniqueBy'])
    const minItems = rawValidation.minItems === undefined
      ? undefined
      : nonNegativeInteger(rawValidation.minItems, `${path}.validation.minItems`)
    const maxItems = rawValidation.maxItems === undefined
      ? undefined
      : nonNegativeInteger(rawValidation.maxItems, `${path}.validation.maxItems`)
    if (maxItems !== undefined && maxItems > PLUGIN_CONFIG_ARRAY_MAX_ITEMS) {
      throw new Error(`Invalid ${path}.validation.maxItems: expected at most ${PLUGIN_CONFIG_ARRAY_MAX_ITEMS}.`)
    }
    if (minItems !== undefined && minItems > (maxItems ?? PLUGIN_CONFIG_ARRAY_MAX_ITEMS)) {
      throw new Error(`Invalid ${path}.validation.minItems: must not exceed effective maxItems.`)
    }
    const uniqueBy = optionalText(rawValidation.uniqueBy, `${path}.validation.uniqueBy`)
    if (uniqueBy !== undefined && (items.type !== 'object'
      || ownProperty(items.properties, uniqueBy) === undefined)) {
      throw new Error(`Invalid ${path}.validation.uniqueBy: expected a declared fixed scalar property.`)
    }
    validation = {
      minItems,
      maxItems,
      uniqueItems: optionalBoolean(rawValidation.uniqueItems, `${path}.validation.uniqueItems`),
      ...(uniqueBy === undefined ? {} : { uniqueBy }),
    }
  }
  return {
    type: 'array',
    title: optionalText(input.title, `${path}.title`),
    description: optionalText(input.description, `${path}.description`),
    default: input.default as PluginConfigArray | undefined,
    required: optionalBoolean(input.required, `${path}.required`),
    items,
    choices: input.choices === undefined
      ? undefined
      : normalizeChoices<PluginConfigArray>(input.choices, `${path}.choices`),
    validation,
  }
}

/** Decode exactly one local property token, never a traversal path. */
export function decodePluginConfigSummaryPath(value: string): string {
  if ([...value].length > PLUGIN_CONFIG_SUMMARY_MAX_PATH_LENGTH || !/^\/(?:[^~/]|~[01])*$/u.test(value)) {
    throw new Error('Invalid summary path: expected one local JSON Pointer property token (at most 128 characters).')
  }
  const property = value.slice(1).replace(/~1/gu, '/').replace(/~0/gu, '~')
  if (isDangerousConfigKey(property)) throw new Error('Invalid summary path: dangerous config key.')
  return property
}

function expandConfigReferences(input: Record<string, unknown>, path: string): Record<string, unknown> {
  const definitions = input.definitions === undefined ? {} : asObject(input.definitions, `${path}.definitions`)
  if (Object.keys(definitions).length > PLUGIN_CONFIG_V3_MAX_DEFINITIONS) {
    throw new Error(`Invalid ${path}.definitions: expected at most ${PLUGIN_CONFIG_V3_MAX_DEFINITIONS} definitions.`)
  }
  for (const name of Object.keys(definitions)) {
    if (!CONFIG_KEY_PATTERN.test(name) || isDangerousConfigKey(name)) {
      throw new Error(`Invalid ${path}.definitions: invalid definition name "${name}".`)
    }
  }
  const expand = (value: unknown, fieldPath: string, chain: string[], child = false): Record<string, unknown> => {
    const field = asObject(value, fieldPath)
    if (Object.hasOwn(field, '$ref')) {
      assertAllowedKeys(field, fieldPath, ['$ref', 'title', 'description', 'default', 'required'])
      const ref = nonEmptyString(field.$ref, `${fieldPath}.$ref`)
      const match = /^#\/config\/definitions\/([A-Za-z][A-Za-z0-9_]*)$/u.exec(ref)
      const name = match?.[1]
      if (name === undefined || isDangerousConfigKey(name) || !Object.hasOwn(definitions, name)) {
        throw new Error(`Invalid ${fieldPath}.$ref: unknown or unsupported local definition reference.`)
      }
      if (chain.includes(name)) throw new Error(`Invalid ${fieldPath}.$ref: circular definition reference.`)
      if (chain.length >= PLUGIN_CONFIG_V3_MAX_REF_DEPTH) {
        throw new Error(`Invalid ${fieldPath}.$ref: expected at most ${PLUGIN_CONFIG_V3_MAX_REF_DEPTH} reference edges.`)
      }
      const result = expand(definitions[name], `${path}.definitions.${name}`, [...chain, name], child)
      for (const key of ['title', 'description', 'default', 'required']) {
        if (Object.hasOwn(field, key)) result[key] = field[key]
      }
      return result
    }
    const result = { ...field }
    if (child) return result
    if (field.type === 'array' && field.items !== undefined) {
      result.items = expand(field.items, `${fieldPath}.items`, chain)
    }
    if (field.properties !== undefined) {
      const properties = asObject(field.properties, `${fieldPath}.properties`)
      if (Object.keys(properties).length > MAX_OBJECT_PROPERTIES) {
        throw new Error(`Invalid ${fieldPath}.properties: expected at most ${MAX_OBJECT_PROPERTIES} properties.`)
      }
      result.properties = Object.fromEntries(Object.entries(properties).map(([key, child]) =>
        [key, expand(child, `${fieldPath}.properties.${key}`, chain, true)]))
    }
    if (field.additionalProperties !== undefined && field.additionalProperties !== false) {
      result.additionalProperties = expand(field.additionalProperties, `${fieldPath}.additionalProperties`, chain, true)
    }
    return result
  }
  // Validate unused definitions too, through the same field/default/choice validator.
  const normalizedDefinitions: PluginConfigSchemaField[] = []
  for (const [name, value] of Object.entries(definitions)) {
    normalizedDefinitions.push(normalizeConfigField(expand(value, `${path}.definitions.${name}`, []), `${path}.definitions.${name}`, true))
  }
  const fields = asObject(input.fields, `${path}.fields`)
  if (Object.keys(fields).length > PLUGIN_CONFIG_V3_MAX_FIELDS) {
    throw new Error(`Invalid ${path}.fields: expected at most ${PLUGIN_CONFIG_V3_MAX_FIELDS} fields.`)
  }
  const expanded = Object.fromEntries(Object.entries(fields).map(([key, value]) =>
    [key, expand(value, `${path}.fields.${key}`, [])]))
  if (normalizedDefinitions.some((definition) => scalarSchemas(definition).some((scalar) => 'valueRef' in scalar && scalar.valueRef !== undefined))) {
    const normalizedFields = Object.fromEntries(Object.entries(expanded).map(([key, value]) =>
      [key, normalizeConfigField(value, `${path}.fields.${key}`, true)]))
    assertValueReferenceSchemas(normalizedFields, normalizedDefinitions, `${path}.definitions`)
  }
  return expanded
}

function normalizeConfigField(rawDefinition: unknown, path: string, allowArray: boolean): PluginConfigSchemaField {
  const rawField = asObject(rawDefinition, path)
  const definition = rawField.type === 'object'
    ? normalizeObjectField(rawField, path)
    : rawField.type === 'array' && allowArray
      ? normalizeArrayField(rawField, path)
    : normalizeScalarField(rawField, path, {
      allowDefault: true, allowRequired: true, allowSensitive: true,
    }) as PluginConfigScalarField
  assertChoices(definition, path)
  if (definition.default !== undefined) {
    const issues = validatePluginConfigValue(definition, definition.default, path)
    if (issues.length > 0) throw new Error(`Invalid ${path}.default: ${formatPluginConfigIssue(issues[0]!)}`)
  }
  return definition
}

function normalizeConfigSummaries(
  input: Record<string, unknown>, fields: Record<string, PluginConfigSchemaField>, path: string,
): Pick<PluginConfigPresentation, 'summaries' | 'fieldViews'> {
  const summaries: Record<string, PluginConfigJoinSummary> = createPropertyMap()
  for (const [name, raw] of Object.entries(input.summaries === undefined ? {} : asObject(input.summaries, `${path}.summaries`))) {
    const summaryPath = `${path}.summaries.${name}`
    if (!CONFIG_KEY_PATTERN.test(name) || isDangerousConfigKey(name)) throw new Error(`Invalid ${summaryPath}: invalid summary name.`)
    const summary = asObject(raw, summaryPath)
    assertAllowedKeys(summary, summaryPath, ['kind', 'parts', 'separator', 'missing'])
    if (summary.kind !== 'join') throw new Error(`Invalid ${summaryPath}.kind: expected join.`)
    if (!Array.isArray(summary.parts) || summary.parts.length < 1 || summary.parts.length > PLUGIN_CONFIG_SUMMARY_MAX_PARTS) {
      throw new Error(`Invalid ${summaryPath}.parts: expected 1..${PLUGIN_CONFIG_SUMMARY_MAX_PARTS} parts.`)
    }
    if (typeof summary.separator !== 'string' || [...summary.separator].length > PLUGIN_CONFIG_SUMMARY_MAX_SEPARATOR_CODE_POINTS) {
      throw new Error(`Invalid ${summaryPath}.separator: expected at most 8 Unicode code points.`)
    }
    if (typeof summary.missing !== 'string') throw new Error(`Invalid ${summaryPath}.missing: expected a string.`)
    summaries[name] = {
      kind: 'join', separator: summary.separator, missing: summary.missing,
      parts: summary.parts.map((rawPart, index) => {
        const partPath = `${summaryPath}.parts[${index}]`
        const part = asObject(rawPart, partPath)
        assertAllowedKeys(part, partPath, ['path', 'format'])
        const propertyPath = nonEmptyString(part.path, `${partPath}.path`)
        try { decodePluginConfigSummaryPath(propertyPath) } catch (error) {
          throw new Error(`Invalid ${partPath}.path: ${(error as Error).message}`)
        }
        if (part.format !== undefined && part.format !== 'raw' && part.format !== 'choiceTitle') {
          throw new Error(`Invalid ${partPath}.format: expected raw or choiceTitle.`)
        }
        return { path: propertyPath, ...(part.format === undefined ? {} : { format: part.format }) }
      }),
    }
  }
  const fieldViews: Record<string, { summary: string; itemSummary?: never } | { itemSummary: string; summary?: never }> = createPropertyMap()
  for (const [key, raw] of Object.entries(input.fieldViews === undefined ? {} : asObject(input.fieldViews, `${path}.fieldViews`))) {
    const viewPath = `${path}.fieldViews.${key}`
    const field = ownProperty(fields, key)
    const view = asObject(raw, viewPath)
    assertAllowedKeys(view, viewPath, ['summary', 'itemSummary'])
    const itemSummary = Object.hasOwn(view, 'itemSummary')
    if (itemSummary === Object.hasOwn(view, 'summary')) {
      throw new Error(`Invalid ${viewPath}: expected exactly one summary reference.`)
    }
    const objectField = itemSummary
      ? field?.type === 'array' && field.items.type === 'object' ? field.items : undefined
      : field?.type === 'object' ? field : undefined
    if (!objectField?.properties) {
      throw new Error(`Invalid ${viewPath}: summary requires a declared fixed object${itemSummary ? ' array item' : ' field'}.`)
    }
    const name = nonEmptyString(itemSummary ? view.itemSummary : view.summary, `${viewPath}.${itemSummary ? 'itemSummary' : 'summary'}`)
    const summary = ownProperty(summaries, name)
    if (!summary) throw new Error(`Invalid ${viewPath}.${itemSummary ? 'itemSummary' : 'summary'}: unknown summary.`)
    for (const part of summary.parts) {
      if (!ownProperty(objectField.properties, decodePluginConfigSummaryPath(part.path))) {
        throw new Error(`Invalid ${viewPath}: summary path "${part.path}" must name a declared scalar property.`)
      }
    }
    fieldViews[key] = itemSummary ? { itemSummary: name } : { summary: name }
  }
  return {
    ...(input.summaries === undefined ? {} : { summaries }),
    ...(input.fieldViews === undefined ? {} : { fieldViews }),
  }
}

export function normalizePluginConfigDefinition(
  value: unknown,
  path = 'config',
): PluginConfigDefinition {
  const input = asObject(value, path)
  const v3 = input.schemaVersion === 3
  assertAllowedKeys(input, path, v3 ? ['schemaVersion', 'definitions', 'fields', 'presentation'] : ['fields', 'presentation'])
  const fieldsInput = v3 ? expandConfigReferences(input, path) : asObject(input.fields, `${path}.fields`)
  const fields = createPropertyMap<PluginConfigSchemaField>()
  for (const [field, rawDefinition] of Object.entries(fieldsInput)) {
    if (!CONFIG_KEY_PATTERN.test(field) || isDangerousConfigKey(field)) {
      throw new Error(`Invalid ${path}.fields: config key "${field}" is not valid.`)
    }
    fields[field] = normalizeConfigField(rawDefinition, `${path}.fields.${field}`, v3)
  }
  assertValueReferenceSchemas(fields, Object.values(fields), path, v3)
  const defaultValues = Object.fromEntries(Object.entries(fields).flatMap(([field, definition]) =>
    definition.default === undefined ? [] : [[field, definition.default]]))
  const defaultIssues = validatePluginConfigReferences({ schemaVersion: 3, fields }, defaultValues, Object.keys(fields))
    .filter((issue) => Object.hasOwn(defaultValues, issue.path.field))
  if (defaultIssues.length > 0) {
    throw new Error(`Invalid ${path}.default: ${formatPluginConfigIssue(defaultIssues[0]!)}`)
  }

  let presentation: PluginConfigDefinition['presentation']
  if (input.presentation !== undefined) {
    const presentationInput = asObject(input.presentation, `${path}.presentation`)
    assertAllowedKeys(presentationInput, `${path}.presentation`, v3 ? ['groups', 'summaries', 'fieldViews'] : ['groups'])
    if (presentationInput.groups !== undefined && !Array.isArray(presentationInput.groups)) {
      throw new Error(`Invalid ${path}.presentation.groups: expected an array.`)
    }
    const groupIds = new Set<string>()
    const groupedFields = new Set<string>()
    presentation = {
      ...(v3 ? normalizeConfigSummaries(presentationInput, fields, `${path}.presentation`) : {}),
      groups: (presentationInput.groups as unknown[] | undefined)?.map((rawGroup, index) => {
        const groupPath = `${path}.presentation.groups[${index}]`
        const group = asObject(rawGroup, groupPath)
        assertAllowedKeys(group, groupPath, ['id', 'title', 'description', 'fields', 'advanced'])
        const id = nonEmptyString(group.id, `${groupPath}.id`)
        if (groupIds.has(id)) {
          throw new Error(`Invalid ${groupPath}.id: duplicate group id "${id}".`)
        }
        groupIds.add(id)
        if (!Array.isArray(group.fields)) {
          throw new Error(`Invalid ${groupPath}.fields: expected an array.`)
        }
        const groupFields = group.fields.map((entry, fieldIndex) => {
          const field = nonEmptyString(entry, `${groupPath}.fields[${fieldIndex}]`)
          if (!Object.hasOwn(fields, field)) {
            throw new Error(`Invalid ${groupPath}.fields[${fieldIndex}]: unknown config key "${field}".`)
          }
          if (groupedFields.has(field)) {
            throw new Error(`Invalid ${groupPath}.fields[${fieldIndex}]: config key "${field}" is assigned to more than one group.`)
          }
          groupedFields.add(field)
          return field
        })
        return {
          id,
          title: nonEmptyString(group.title, `${groupPath}.title`),
          description: optionalText(group.description, `${groupPath}.description`),
          fields: groupFields,
          advanced: optionalBoolean(group.advanced, `${groupPath}.advanced`),
        }
      }),
    }
  }
  return { ...(v3 ? { schemaVersion: 3 as const } : {}), fields, presentation } as PluginConfigDefinition
}
