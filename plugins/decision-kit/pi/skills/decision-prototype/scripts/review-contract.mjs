import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { validateFeedbackForPrototype } from '../assets/review-shell/review-policy.mjs';

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
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === expected;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
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

function hasDuplicateItems(values) {
  const serialized = values.map((value) => JSON.stringify(value));
  return new Set(serialized).size !== serialized.length;
}

function validate(value, schema, location, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => {
      const candidateErrors = [];
      validate(value, candidate, location, candidateErrors);
      return candidateErrors.length === 0;
    });
    if (matches.length !== 1) errors.push(`${location} must match exactly one allowed shape`);
    return;
  }
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
  if ((schema.type === 'integer' || schema.type === 'number') && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${location} must be at least ${schema.minimum}`);
  }
  if ((schema.type === 'integer' || schema.type === 'number') && schema.maximum !== undefined && value > schema.maximum) {
    errors.push(`${location} must be at most ${schema.maximum}`);
  }
  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${location} must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${location} must contain at most ${schema.maxItems} item(s)`);
    }
    if (schema.uniqueItems && hasDuplicateItems(value)) {
      errors.push(`${location} must contain unique items`);
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

function validatePrototypeCapabilities(value, label, errors) {
  if (!matchesType(value, 'object') || !Array.isArray(value.options)) return;

  const optionIds = new Set();
  for (const option of value.options) {
    if (typeof option?.id !== 'string') continue;
    if (optionIds.has(option.id)) errors.push(`${label}.options contains duplicate id ${JSON.stringify(option.id)}`);
    optionIds.add(option.id);
  }
  if (value.selectionMode === 'none' && value.options.length !== 1) {
    errors.push(`${label}.selectionMode "none" requires exactly one option`);
  }

  const questionIds = new Set();
  if (Array.isArray(value.guidedQuestions)) {
    for (const question of value.guidedQuestions) {
      if (typeof question?.id !== 'string') continue;
      if (questionIds.has(question.id)) errors.push(`${label}.guidedQuestions contains duplicate id ${JSON.stringify(question.id)}`);
      questionIds.add(question.id);
      const mode = question.selectionMode || 'single';
      if (['single', 'multiple'].includes(mode) && !Array.isArray(question.choices)) {
        errors.push(`${label}.guidedQuestions ${JSON.stringify(question.id)} requires choices for selectionMode ${JSON.stringify(mode)}`);
      }
    }
  }

  const hasHtml = value.options.some((option) => option?.kind === 'html');
  const hasImage = value.options.some((option) => option?.kind === 'image');
  const hasStaticHtml = hasHtml && value.htmlExecution === 'static';
  if (value.htmlExecution === 'sandboxed' && !hasHtml) {
    errors.push(`${label}.htmlExecution "sandboxed" requires at least one html option`);
  }
  if (value.allowAnnotations && !hasImage && !hasStaticHtml) {
    errors.push(`${label}.allowAnnotations requires an image or static html option`);
  }
  if (value.editableCssVariables === undefined) return;

  const names = matchesType(value.editableCssVariables, 'object')
    ? Object.keys(value.editableCssVariables)
    : [];
  if (names.length === 0) {
    errors.push(`${label}.editableCssVariables must contain at least one CSS custom property`);
  }
  for (const name of names) {
    if (!name.startsWith('--') || name.length === 2) {
      errors.push(`${label}.editableCssVariables.${name} must start with "--" and include a name`);
    }
  }
  if (!hasStaticHtml) {
    errors.push(`${label}.editableCssVariables requires at least one static html option`);
  }
}

export async function readJsonSchema(schemaPath) {
  return JSON.parse(await readFile(schemaPath, 'utf8'));
}

export async function loadAndValidatePrototype(prototypePath, prototypeSchema) {
  const requested = path.resolve(prototypePath);
  const info = await lstat(requested);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Prototype config must be a regular non-symlink file');
  const prototypeRoot = await realpath(path.dirname(requested));
  const physicalPrototypePath = await realpath(requested);
  if (!isInside(prototypeRoot, physicalPrototypePath)) throw new Error('Prototype config escapes its root');
  const config = normalizeAndValidate(
    JSON.parse(await readFile(physicalPrototypePath, 'utf8')),
    prototypeSchema,
    'prototype',
  );

  const artifactRoot = path.join(prototypeRoot, 'artifact');
  const artifactInfo = await lstat(artifactRoot);
  if (!artifactInfo.isDirectory() || artifactInfo.isSymbolicLink()) {
    throw new Error('Prototype artifact/ must be a regular non-symlink directory');
  }
  const physicalArtifactRoot = await realpath(artifactRoot);
  for (const option of config.options) {
    const artifact = option.artifact;
    if (path.isAbsolute(artifact)) throw new Error(`Prototype artifact ${JSON.stringify(artifact)} must be relative`);
    const target = path.resolve(prototypeRoot, artifact);
    if (!isInside(artifactRoot, target)) {
      throw new Error(`Prototype artifact ${JSON.stringify(artifact)} must be inside artifact/`);
    }
    const targetInfo = await lstat(target);
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
      throw new Error(`Prototype artifact ${JSON.stringify(artifact)} must be a regular non-symlink file`);
    }
    const physicalTarget = await realpath(target);
    if (!isInside(physicalArtifactRoot, physicalTarget)) {
      throw new Error(`Prototype artifact ${JSON.stringify(artifact)} escapes artifact/ through a symbolic link`);
    }
  }

  return {
    config,
    artifactRoot,
    physicalArtifactRoot,
    prototypePath: physicalPrototypePath,
    prototypeRoot,
  };
}

export function normalizeAndValidate(value, schema, label) {
  const normalized = structuredClone(value);
  applyDefaults(normalized, schema);
  const errors = [];
  validate(normalized, schema, label, errors);
  if (schema.title === 'PrototypeReviewConfig') {
    validatePrototypeCapabilities(normalized, label, errors);
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
  return normalized;
}

export function validateFeedbackAgainstPrototype(value, prototype, label = 'feedback') {
  return validateFeedbackForPrototype(value, prototype, label);
}
