import type {
  PluginConfigAdditionalPropertiesField,
  PluginConfigChoices,
  PluginConfigDefinition,
  PluginConfigNumberValidation,
  PluginConfigObject,
  PluginConfigObjectField,
  PluginConfigObjectPropertyField,
  PluginConfigPreset,
  PluginConfigScalar,
  PluginConfigScalarField,
  PluginConfigSchemaField,
  PluginConfigStringFormat,
  PluginConfigStringValidation,
  PluginConfigValidationIssue,
  PluginConfigValue,
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
const MAX_OBJECT_PROPERTIES = 32
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
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    throw new Error(`Invalid ${path}: minLength must be less than or equal to maxLength.`)
  }
  if (input.pattern !== undefined && typeof input.pattern !== 'string') {
    throw new Error(`Invalid ${path}.pattern: expected a string.`)
  }
  const pattern = input.pattern as string | undefined
  if (pattern !== undefined) {
    try {
      new RegExp(pattern, 'u')
    } catch {
      throw new Error(`Invalid ${path}.pattern: expected a valid regular expression.`)
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
  if (validation?.pattern !== undefined && !new RegExp(validation.pattern, 'u').test(value)) {
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
  return issues
}

export function canonicalizePluginConfigValue(value: PluginConfigValue): PluginConfigValue {
  if (typeof value !== 'object') return value
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
    : validateScalarField(definition, preset.value, field, undefined, false)
}

export type RedactedPluginConfigValue = PluginConfigValue | '[redacted]' | Record<string, PluginConfigScalar | '[redacted]'>

export function redactPluginConfigValue(
  definition: PluginConfigSchemaField,
  value: PluginConfigValue,
): RedactedPluginConfigValue {
  if (definition.sensitive === true) return '[redacted]'
  if (definition.type !== 'object' || typeof value !== 'object') return value
  const redacted = createPropertyMap<PluginConfigScalar | '[redacted]'>()
  for (const [property, childValue] of Object.entries(value)) {
    const child = ownProperty(definition.properties, property) ?? (
      definition.additionalProperties === false ? undefined : definition.additionalProperties
    )
    redacted[property] = child?.sensitive === true ? '[redacted]' : childValue
  }
  return redacted
}

export function formatPluginConfigIssue(issue: PluginConfigValidationIssue): string {
  const path = issue.path.property === undefined
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
  options: { allowDefault: boolean; allowRequired: boolean },
): PluginConfigScalarField | PluginConfigObjectPropertyField | PluginConfigAdditionalPropertiesField {
  const input = asObject(value, path)
  const type = nonEmptyString(input.type, `${path}.type`)
  if (type !== 'string' && type !== 'number' && type !== 'boolean') {
    throw new Error(`Invalid ${path}.type: expected string, number, or boolean.`)
  }
  const allowed = ['type', 'title', 'description', 'sensitive']
  if (options.allowDefault) allowed.push('default')
  if (options.allowRequired) allowed.push('required')
  allowed.push('choices')
  if (type !== 'boolean') allowed.push('validation')
  assertAllowedKeys(input, path, allowed)
  const common = {
    title: optionalText(input.title, `${path}.title`),
    description: optionalText(input.description, `${path}.description`),
    required: options.allowRequired ? optionalBoolean(input.required, `${path}.required`) : undefined,
    sensitive: optionalBoolean(input.sensitive, `${path}.sensitive`),
  }
  const defaultValue = options.allowDefault && input.default !== undefined
    ? input.default
    : undefined
  if (type === 'string') {
    return {
      type,
      ...common,
      default: defaultValue as string | undefined,
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
      default: defaultValue as number | undefined,
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
    default: defaultValue as boolean | undefined,
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
    'sensitive',
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
      { allowDefault: false, allowRequired: false },
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
    sensitive: optionalBoolean(input.sensitive, `${path}.sensitive`),
    choices: input.choices === undefined
      ? undefined
      : normalizeChoices<PluginConfigObject>(input.choices, `${path}.choices`),
    ...(properties === undefined
      ? { additionalProperties: additionalProperties as PluginConfigAdditionalPropertiesField }
      : { properties, additionalProperties: false as const }),
    validation,
  }
}

export function normalizePluginConfigDefinition(
  value: unknown,
  path = 'config',
): PluginConfigDefinition {
  const input = asObject(value, path)
  assertAllowedKeys(input, path, ['fields', 'presentation'])
  const fieldsInput = asObject(input.fields, `${path}.fields`)
  const fields = createPropertyMap<PluginConfigSchemaField>()
  for (const [field, rawDefinition] of Object.entries(fieldsInput)) {
    if (!CONFIG_KEY_PATTERN.test(field) || isDangerousConfigKey(field)) {
      throw new Error(`Invalid ${path}.fields: config key "${field}" is not valid.`)
    }
    const rawField = asObject(rawDefinition, `${path}.fields.${field}`)
    const definition = rawField.type === 'object'
      ? normalizeObjectField(rawField, `${path}.fields.${field}`)
      : normalizeScalarField(rawField, `${path}.fields.${field}`, {
          allowDefault: true,
          allowRequired: true,
        }) as PluginConfigScalarField
    assertChoices(definition, `${path}.fields.${field}`)
    if (definition.default !== undefined) {
      const issues = validatePluginConfigValue(definition, definition.default, field)
      if (issues.length > 0) {
        throw new Error(`Invalid ${path}.fields.${field}.default: ${formatPluginConfigIssue(issues[0]!)}`)
      }
    }
    fields[field] = definition
  }

  let presentation: PluginConfigDefinition['presentation']
  if (input.presentation !== undefined) {
    const presentationInput = asObject(input.presentation, `${path}.presentation`)
    assertAllowedKeys(presentationInput, `${path}.presentation`, ['groups'])
    if (presentationInput.groups !== undefined && !Array.isArray(presentationInput.groups)) {
      throw new Error(`Invalid ${path}.presentation.groups: expected an array.`)
    }
    const groupIds = new Set<string>()
    const groupedFields = new Set<string>()
    presentation = {
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
  return { fields, presentation }
}
