type JsonSchema = Record<string, unknown>

function matchesType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value)
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}

function isRfc3339DateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/u.exec(value)
  if (!match) return false
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText)
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText)
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60) return false
  if (offsetHour > 23 || offsetMinute > 59) return false
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= daysInMonth[month - 1]!
}

function resolveLocalReference(root: JsonSchema, reference: string): JsonSchema | null {
  if (!reference.startsWith('#/')) return null
  let current: unknown = root
  for (const rawSegment of reference.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/gu, '/').replace(/~0/gu, '~')
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null
    current = (current as Record<string, unknown>)[segment]
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? current as JsonSchema
    : null
}

function validateNode(
  schema: JsonSchema,
  value: unknown,
  pointer: string,
  errors: string[],
  root: JsonSchema,
): void {
  if (typeof schema.$ref === 'string') {
    const referenced = resolveLocalReference(root, schema.$ref)
    if (!referenced) errors.push(`${pointer}: unsupported schema reference ${schema.$ref}`)
    else validateNode(referenced, value, pointer, errors, root)
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((entry) => {
      if (!entry || typeof entry !== 'object') return false
      const branchErrors: string[] = []
      validateNode(entry as JsonSchema, value, pointer, branchErrors, root)
      return branchErrors.length === 0
    }).length
    if (matches !== 1) errors.push(`${pointer}: must match exactly one allowed shape`)
  }
  if (Array.isArray(schema.allOf)) {
    for (const entry of schema.allOf) {
      if (entry && typeof entry === 'object') validateNode(entry as JsonSchema, value, pointer, errors, root)
    }
  }
  if (schema.if && typeof schema.if === 'object') {
    const conditionalErrors: string[] = []
    validateNode(schema.if as JsonSchema, value, pointer, conditionalErrors, root)
    const branch = conditionalErrors.length === 0 ? schema.then : schema.else
    if (branch && typeof branch === 'object') validateNode(branch as JsonSchema, value, pointer, errors, root)
  }
  if (schema.const !== undefined && !Object.is(value, schema.const))
    errors.push(`${pointer}: must equal ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value)))
    errors.push(`${pointer}: must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`)
  const types = schema.type === undefined
    ? []
    : Array.isArray(schema.type)
      ? schema.type as string[]
      : [schema.type as string]
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    errors.push(`${pointer}: must have type ${types.join(' or ')}`)
    return
  }
  if (typeof value === 'string') {
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      errors.push(`${pointer}: must have length <= ${schema.maxLength}`)
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      errors.push(`${pointer}: must have length >= ${schema.minLength}`)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value))
      errors.push(`${pointer}: must match ${schema.pattern}`)
    if (schema.format === 'date-time' && !isRfc3339DateTime(value))
      errors.push(`${pointer}: must be an RFC 3339 date-time`)
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      errors.push(`${pointer}: must be >= ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      errors.push(`${pointer}: must be <= ${schema.maximum}`)
    if (
      typeof schema.multipleOf === 'number' &&
      Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9
    ) errors.push(`${pointer}: must be a multiple of ${schema.multipleOf}`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      errors.push(`${pointer}: must contain at most ${schema.maxItems} items`)
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      errors.push(`${pointer}: must contain at least ${schema.minItems} items`)
    if (schema.uniqueItems === true && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length)
      errors.push(`${pointer}: must contain unique items`)
    if (schema.items && typeof schema.items === 'object')
      value.forEach((entry, index) => validateNode(schema.items as JsonSchema, entry, `${pointer}/${index}`, errors, root))
    if (Array.isArray(schema.prefixItems)) schema.prefixItems.forEach((entry, index) => {
      if (index < value.length && entry && typeof entry === 'object') validateNode(entry as JsonSchema, value[index], `${pointer}/${index}`, errors, root)
    })
  }
  if (matchesType(value, 'object')) {
    const object = value as Record<string, unknown>
    for (const key of (schema.required as string[] | undefined) ?? [])
      if (!Object.hasOwn(object, key)) errors.push(`${pointer}: missing required property ${key}`)
    const properties = schema.properties as Record<string, JsonSchema> | undefined
    for (const [key, entry] of Object.entries(object)) {
      if (properties?.[key]) validateNode(properties[key], entry, `${pointer}/${key}`, errors, root)
      else if (schema.additionalProperties === false) errors.push(`${pointer}: unknown property ${key}`)
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
        validateNode(schema.additionalProperties as JsonSchema, entry, `${pointer}/${key}`, errors, root)
    }
  }
}

export function validateJsonSchema(schema: JsonSchema, value: unknown): string[] {
  const errors: string[] = []
  validateNode(schema, value, '$', errors, schema)
  return errors
}
