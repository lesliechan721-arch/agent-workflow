import { readFile } from 'node:fs/promises';

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, expected) {
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'integer') return Number.isInteger(value);
  return typeof value === expected;
}

function applyDefaults(value, schema) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object' && matchesType(value, 'object')) {
    for (const [key, propertySchema] of Object.entries(schema.properties || {})) {
      if (value[key] === undefined && propertySchema.default !== undefined) {
        value[key] = structuredClone(propertySchema.default);
      }
      if (value[key] !== undefined) applyDefaults(value[key], propertySchema);
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (!(key in (schema.properties || {}))) applyDefaults(child, schema.additionalProperties);
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    for (const child of value) applyDefaults(child, schema.items);
  }
}

function validate(value, schema, location, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    errors.push(`${location} must equal ${JSON.stringify(schema.const)}`);
    return;
  }
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${location} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`);
    return;
  }
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${location} must be ${schema.type}; received ${valueType(value)}`);
    return;
  }
  if (schema.type === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${location} must contain at least ${schema.minLength} character(s)`);
  }
  if (schema.type === 'integer' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${location} must be at least ${schema.minimum}`);
  }
  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${location} must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.items) value.forEach((child, index) => validate(child, schema.items, `${location}[${index}]`, errors));
  }
  if (schema.type === 'object') {
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (value[key] === undefined) errors.push(`${location}.${key} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) validate(child, properties[key], `${location}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${location}.${key} is not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validate(child, schema.additionalProperties, `${location}.${key}`, errors);
      }
    }
  }
}

export async function readJsonSchema(schemaPath) {
  return JSON.parse(await readFile(schemaPath, 'utf8'));
}

export function normalizeAndValidate(value, schema, label) {
  const normalized = structuredClone(value);
  applyDefaults(normalized, schema);
  const errors = [];
  validate(normalized, schema, label, errors);
  if (errors.length > 0) throw new Error(errors.join('; '));
  return normalized;
}
