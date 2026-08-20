type JsonSchema = Record<string, unknown>

function matchesType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value)
  if (type === 'integer') return Number.isInteger(value)
  return typeof value === type
}

function validateNode(schema: JsonSchema, value: unknown, pointer: string, errors: string[]): void {
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
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      errors.push(`${pointer}: must have length >= ${schema.minLength}`)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value))
      errors.push(`${pointer}: must match ${schema.pattern}`)
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
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      errors.push(`${pointer}: must contain at least ${schema.minItems} items`)
    if (schema.uniqueItems === true && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length)
      errors.push(`${pointer}: must contain unique items`)
    if (schema.items && typeof schema.items === 'object')
      value.forEach((entry, index) => validateNode(schema.items as JsonSchema, entry, `${pointer}/${index}`, errors))
  }
  if (matchesType(value, 'object')) {
    const object = value as Record<string, unknown>
    for (const key of (schema.required as string[] | undefined) ?? [])
      if (!Object.hasOwn(object, key)) errors.push(`${pointer}: missing required property ${key}`)
    const properties = schema.properties as Record<string, JsonSchema> | undefined
    for (const [key, entry] of Object.entries(object)) {
      if (properties?.[key]) validateNode(properties[key], entry, `${pointer}/${key}`, errors)
      else if (schema.additionalProperties === false) errors.push(`${pointer}: unknown property ${key}`)
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
        validateNode(schema.additionalProperties as JsonSchema, entry, `${pointer}/${key}`, errors)
    }
  }
}

export function validateJsonSchema(schema: JsonSchema, value: unknown): string[] {
  const errors: string[] = []
  validateNode(schema, value, '$', errors)
  return errors
}
